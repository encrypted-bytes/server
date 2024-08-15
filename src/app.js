import 'dotenv/config';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fs from 'fs';
import crypto, { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import fastifyStatic from '@fastify/static';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import pointOfView from '@fastify/view';
import ejs from 'ejs';
import cron from 'node-cron';
import cleanup from './cron/cleanup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fastify = Fastify({ logger: process.env.SERVER_ENV === 'DEV' ? true : false, maxParamLength: 1000 });
const serverSecretKey = crypto.createHash('sha256').update(process.env.SERVER_SECRET_KEY).digest();

fastify.register(pointOfView, {
  engine: {
    ejs
  },
  root: path.join(__dirname, 'views'),
});

fastify.register(fastifyMultipart, {
  limits: {
    files: 1,
    fileSize: process.env.SERVER_MAX_UPLOAD * 1024 * 1024 * 1024
  }
});

fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'views')
});

fastify.get('/favicon.ico', async (request, reply) => {
  reply.header('Content-Type', 'image/x-icon');
  return reply.sendFile('favicon.ico');
});

fastify.get('/', async (request, reply) => {
  return reply.view('index.html', { hostName: request.headers.host, maxSize: process.env.SERVER_MAX_UPLOAD, stats: await getStats() });
});

const getStats = async () => {
  const statsFilePath = path.join(__dirname, 'stats.json');
  try {
    const data = await fs.promises.readFile(statsFilePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {
      totalSize: 0,
      fileCount: 0
    };
  }
};

const handleFileUpload = async (buffer, originalName, retention) => {
  const password = randomBytes(32).toString('hex');
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(password, 'hex'), iv);
  const encryptedBuffer = Buffer.concat([cipher.update(buffer), cipher.final()]);

  let hash = crypto.createHash('sha256').update(encryptedBuffer).digest('hex').slice(0, 10);
  let filePath = path.join(__dirname, '../files', retention ? `${retention}_${hash}` : hash);

  while (fs.existsSync(filePath)) {
    const randomBytes = crypto.randomBytes(4).toString('hex');
    hash = crypto.createHash('sha256').update(encryptedBuffer).update(randomBytes).digest('hex').slice(0, 10);
    filePath = path.join(__dirname, '../files', retention ? `${retention}_${hash}` : hash);
  }

  const ext = path.extname(originalName);
  //const baseName = path.basename(originalName, ext);
  const finalName = ext ? `${hash}${ext}` : hash; // Use baseName if no extension

  const dataToEncrypt = `${hash}:${iv.toString('hex')}:${retention || ''}:${finalName}`;
  const encryptedData = encryptData(dataToEncrypt, serverSecretKey);
  return { filePath, encryptedData, encryptedBuffer, password };
};

const encryptData = (data, key) => {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
};

const decryptData = (encryptedData, key) => {
  const [ivHex, encryptedHex] = encryptedData.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
};

fastify.post('/upload', async (request, reply) => {
    const data = await request.file();
    const buffer = await data.toBuffer();
    if(buffer.length === 0) {
        throw new CustomError('No file uploaded', 400);
    }
    const retention = (data.fields.retention && [0, 1, 3, 7, 30].includes(parseInt(data.fields.retention.value))) ? data.fields.retention.value : null;

    const { filePath, encryptedData, encryptedBuffer, password } = await handleFileUpload(buffer, data.filename, retention);
    await fs.promises.writeFile(filePath, encryptedBuffer);

    const userAgent = request.headers['user-agent'];
    const downloadLink = `https://${request.headers.host}/download/${encodeURIComponent(encryptedData)}/${encodeURIComponent(password)}`;
    
    if (userAgent && (userAgent.includes('curl') || userAgent.includes('wget'))) {
      return reply.status(201).send(downloadLink);
    } else {
      return reply.status(201).view('upload.html', { downloadLink, hostName: request.headers.host, maxSize: process.env.SERVER_MAX_UPLOAD, stats: await getStats() });
    }
});

fastify.get('/download/:encryptedData/:encryptionKey', async (request, reply) => {
  const { encryptedData, encryptionKey } = request.params;
  let decodedString;
  try {
    decodedString = decryptData(decodeURIComponent(encryptedData), serverSecretKey);
  } catch (error) {
    throw new CustomError('Invalid encrypted data', 400);
  }
  const [decodedFilename, ivHex, retention, ext] = decodedString.split(':');
  if (!decodedFilename || !ivHex || !ext) {
    throw new CustomError('Invalid data provided', 400);
  }
  const filePath = path.join(__dirname, '../files', retention ? `${retention}_${decodedFilename}` : decodedFilename);

  if (fs.existsSync(filePath)) {
    let encryptedBuffer;
    try {
      encryptedBuffer = await fs.promises.readFile(filePath);
    } catch (error) {
      throw new CustomError('File read failed');
    }

    try {
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = createDecipheriv('aes-256-cbc', Buffer.from(encryptionKey, 'hex'), iv);
      const decryptedBuffer = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);

      reply.header('Content-Disposition', `attachment; filename=${decodedFilename}${ext}`);
      return reply.send(decryptedBuffer);
    } catch (error) {
      throw new CustomError('Decryption failed', 403);
    }
  } else {
    console.log(filePath);
    throw new CustomError('File not found', 404);
  }
});

fastify.setNotFoundHandler((request, reply) => {
  return reply.redirect('/');
});

fastify.setErrorHandler((error, request, reply) => {
  if (error.validation) {
    return reply.status(400).send('Validation error');
  }

  if(error.code === 'FST_REQ_FILE_TOO_LARGE') {
    return reply.status(413).send('File too large');
  }

  if(error instanceof CustomError) {
    return reply.status(error.statusCode).send(error.message);
  }
  
  console.log(error);
  
  return reply.status(500).send('An unexpected error occurred');
});

class CustomError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'CustomError';
    this.statusCode = statusCode;
  }
}

const cleanupInstance = new cleanup();
cron.schedule('* * * * *', () => {
  console.log('Running cleanup job');
  cleanupInstance.run();
}, {
  scheduled: true
});

const start = async () => {
  try {
    fastify.listen({ port: 5000 });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
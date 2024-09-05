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
import { pipeline } from 'stream/promises';
import { createWriteStream, createReadStream } from 'fs';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const serverSecretKey = crypto.createHash('sha256').update(process.env.SERVER_SECRET_KEY).digest();

const tempDir = path.join(__dirname, '../temp');
const filesDir = path.join(__dirname, '../files');

let httpsOptions;
let isHttps = true;
try {
  httpsOptions = {
    key: fs.readFileSync(__dirname + '/../ssl/privkey.pem'),
    cert: fs.readFileSync(__dirname + '/../ssl/cert.pem')
  };
} catch (error) {
  console.error(error);
  console.warn('SSL certificates not found or invalid. Falling back to HTTP.');
}
const fastify = Fastify({
  logger: process.env.SERVER_ENV === 'DEV' ? true : false,
  maxParamLength: 1000,
  https: process.env.SERVER_ENV === 'DEV' ? undefined : isHttps ? httpsOptions : undefined
});

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
  return reply.view('index.html', { maxSize: process.env.SERVER_MAX_UPLOAD, stats: await getStats() });
});

fastify.setNotFoundHandler((request, reply) => {
  return reply.redirect('/');
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


fastify.post('/upload', async (request, reply) => {
  const data = await request.file();
  if (!data.file || !data.file.bytesRead) {
    if (request.headers['user-agent'].toLowerCase().includes('curl')) {
      return reply.status(400).send('No file provided');
    }
    return reply.code(400).view('error.html', { errorMessage: 'No file provided', maxSize: process.env.SERVER_MAX_UPLOAD, stats: await getStats() });
  }
  
  if (data.file.bytesRead > process.env.SERVER_MAX_UPLOAD * 1024 * 1024 * 1024) {
    if (request.headers['user-agent'].toLowerCase().includes('curl')) {
      return reply.status(413).send(`File size exceeds the maximum limit of ${process.env.SERVER_MAX_UPLOAD} GB`);
    }
    return reply.code(413).view('error.html', { errorMessage: `File size exceeds the maximum limit of ${process.env.SERVER_MAX_UPLOAD} GB`, maxSize: process.env.SERVER_MAX_UPLOAD, stats: await getStats() });
  }
  
  const fileName = randomBytes(16).toString('hex');
  const fileKey = randomBytes(32);
  const fileIV = randomBytes(16);
  const fileCipher = createCipheriv('aes-256-cbc', fileKey, fileIV);

  const fileTempPath = path.join(tempDir, `${randomBytes(16).toString('hex')}`);

  try {
    await fs.promises.mkdir(tempDir, { recursive: true });
    await fs.promises.mkdir(filesDir, { recursive: true });
    await pipeline(
      data.file,
      fileCipher,
      createWriteStream(fileTempPath)
    );
    await fs.promises.rename(fileTempPath, path.join(filesDir, fileName));

    const dataToEncrypt = JSON.stringify({ fileName: fileName, fileExtension: path.extname(data.filename) });
    const dataIV = randomBytes(16);
    const dataCipher = createCipheriv('aes-256-cbc', Buffer.from(serverSecretKey), dataIV);
    let encryptedFileData = dataCipher.update(dataToEncrypt, 'utf8', 'hex');
    encryptedFileData += dataCipher.final('hex');

    if (request.headers['user-agent'].toLowerCase().includes('curl')) {
      return reply.status(201).send((isHttps ? 'https' : 'http') + `://${request.headers.host}/download/${fileKey.toString('hex')}/${fileIV.toString('hex')}/${encryptedFileData}/${dataIV.toString('hex')}`);
    }
    return reply.status(201).view('upload.html', { downloadLink: (isHttps ? 'https' : 'http') + `://${request.headers.host}/download/${fileKey.toString('hex')}/${fileIV.toString('hex')}/${encryptedFileData}/${dataIV.toString('hex')}`, maxSize: process.env.SERVER_MAX_UPLOAD, stats: await getStats() });
  } catch (error) {
    if (request.headers['user-agent'].toLowerCase().includes('curl')) {
      return reply.status(500).send('File upload failed');
    }
    return reply.code(500).view('error.html', { errorMessage: 'File upload failed', maxSize: process.env.SERVER_MAX_UPLOAD, stats: await getStats() });
  }
});

fastify.get('/download/:fileEncryptionKey/:fileIV/:encryptedFileData/:dataIV', async (request, reply) => {
  const { fileEncryptionKey, fileIV, encryptedFileData, dataIV } = request.params;

  try {
    const dataDecipher = createDecipheriv('aes-256-cbc', Buffer.from(serverSecretKey), Buffer.from(dataIV, 'hex'));
    let decryptedData = dataDecipher.update(encryptedFileData, 'hex', 'utf8');
    decryptedData += dataDecipher.final('utf8');
    const { fileName, fileExtension } = JSON.parse(decryptedData);

    try {
      const fileKey = Buffer.from(fileEncryptionKey, 'hex');
      const fileIVBuffer = Buffer.from(fileIV, 'hex');
      const fileDecipher = createDecipheriv('aes-256-cbc', fileKey, fileIVBuffer);
      const filePath = path.join(filesDir, fileName);
      if (!fs.existsSync(filePath)) {
        return reply.code(500).view('error.html', { errorMessage: 'This file has been removed', maxSize: process.env.SERVER_MAX_UPLOAD, stats: await getStats() });
      }

      if (['.png', '.jpg', '.jpeg', '.gif', '.txt', '.pdf', '.css', '.js', '.mp4', '.mp3'].includes(fileExtension)) {
        reply.header('Content-Disposition', `inline; filename="${fileName + fileExtension}"`);
      } else {
        reply.header('Content-Disposition', `attachment; filename="${fileName + fileExtension}"`);
      }
      const readStream = createReadStream(filePath);
      return reply.send(readStream.pipe(fileDecipher));
    } catch (error) {
      if (request.headers['user-agent'].toLowerCase().includes('curl')) {
        return reply.status(400).send('Invalid file data given');
      }
      return reply.code(400).view('error.html', { errorMessage: 'Invalid file data given', maxSize: process.env.SERVER_MAX_UPLOAD, stats: await getStats() });
    }
  } catch (er) {
    if (request.headers['user-agent'].toLowerCase().includes('curl')) {
      return reply.status(500).send('File decryption failed');
    }
    return reply.code(500).view('error.html', { errorMessage: 'File decryption failed', maxSize: process.env.SERVER_MAX_UPLOAD, stats: await getStats() });
  }
});

const cleanupInstance = new cleanup();
cron.schedule('* * * * *', () => {
  cleanupInstance.run();
}, {
  scheduled: true
});

const start = async () => {
  try {
    if (process.env.SERVER_ENV !== 'DEV' && isHttps) {
      http.createServer((req, res) => {
        res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
        res.end();
      }).listen(80);
      console.log('HTTP redirect server running on port 80');
    }

    const port = process.env.SERVER_ENV === 'DEV' ? 5000 : isHttps ? 443 : 80;
    await fastify.listen({
      port: port,
      host: '0.0.0.0'
    });
    console.log(`Server is running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
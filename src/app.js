import 'dotenv/config';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fs from 'fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'fs';
import crypto, { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import fastifyStatic from '@fastify/static';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import pointOfView from '@fastify/view';
import ejs from 'ejs';
import cron from 'node-cron';
import cleanup from './cron/cleanup.js';
import { pipeline } from 'stream/promises';
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
    key: await fs.readFile(__dirname + '/../ssl/privkey.pem'),
    cert: await fs.readFile(__dirname + '/../ssl/cert.pem')
  };
} catch (error) {
  console.error(error);
  console.warn('SSL certificates not found or invalid. Falling back to HTTP.');
}
const fastify = Fastify({
  logger: false,
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
    const data = await fs.readFile(statsFilePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {
      totalSize: 0,
      fileCount: 0
    };
  }
};

fastify.post('/upload', async (request, reply) => {
  try {
    const data = await request.file();
    if (!data.file || !data.file.bytesRead) {
      return handleError(reply, 'No file provided', 400);
    }
    
    if (data.file.bytesRead > process.env.SERVER_MAX_UPLOAD * 1024 * 1024 * 1024) {
      return handleError(reply, `File size exceeds the maximum limit of ${process.env.SERVER_MAX_UPLOAD} GB`, 413);
    }
    
    const fileName = randomBytes(16).toString('hex');
    const fileKey = randomBytes(32);
    const fileIV = randomBytes(16);
    const fileCipher = createCipheriv('aes-256-cbc', fileKey, fileIV);
    
    await pipeline(
      data.file,
      fileCipher,
      createWriteStream(path.join(filesDir, fileName))
    );

    const dataToEncrypt = JSON.stringify({ 
      fileName: fileName, 
      fileExtension: path.extname(data.filename),
      clientEncrypted: !!request.headers['x-client-encrypted']
    });
    
    const dataIV = randomBytes(16);
    const dataCipher = createCipheriv('aes-256-cbc', Buffer.from(serverSecretKey), dataIV);
    let encryptedFileData = dataCipher.update(dataToEncrypt, 'utf8', 'hex');
    encryptedFileData += dataCipher.final('hex');

    const downloadLink = `${process.env.SERVER_ENV !== 'DEV' && isHttps ? 'https' : 'http'}://${request.headers.host}/download/${fileKey.toString('hex')}/${fileIV.toString('hex')}/${encryptedFileData}/${dataIV.toString('hex')}`;
    
    if (request.headers['user-agent'].toLowerCase().includes('curl') || request.headers['return-url']) {
      return reply.status(201).send(downloadLink);
    }
    
    return reply.status(201).view('upload.html', { 
      downloadLink,
      maxSize: process.env.SERVER_MAX_UPLOAD,
      stats: await getStats()
    });
  } catch (error) {
    console.error('Error during file upload:', error);
    return handleError(reply, 'Internal server error during file upload', 500);
  }
});

fastify.get('/download/:fileEncryptionKey/:fileIV/:encryptedFileData/:dataIV', async (request, reply) => {
  const { fileEncryptionKey, fileIV, encryptedFileData, dataIV } = request.params;

  try {
    const dataDecipher = createDecipheriv('aes-256-cbc', Buffer.from(serverSecretKey), Buffer.from(dataIV, 'hex'));
    let decryptedData = dataDecipher.update(encryptedFileData, 'hex', 'utf8');
    decryptedData += dataDecipher.final('utf8');
    const { fileName, fileExtension } = JSON.parse(decryptedData);

    const fileKey = Buffer.from(fileEncryptionKey, 'hex');
    const fileIVBuffer = Buffer.from(fileIV, 'hex');
    const fileDecipher = createDecipheriv('aes-256-cbc', fileKey, fileIVBuffer);
    const filePath = path.join(filesDir, fileName);
    if (!existsSync(filePath)) {
      return handleError(reply, 'This file has been removed', 404);
    }

    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.txt': 'text/plain',
      '.pdf': 'application/pdf',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg'
    };

    const mimeType = mimeTypes[fileExtension.toLowerCase()];

    if (mimeType) {
      reply.header('Content-Type', mimeType);
      reply.header('Content-Disposition', `inline; filename="${fileName + fileExtension}"`);
    } else {
      reply.header('Content-Disposition', `attachment; filename="${fileName + fileExtension}"`);
    }

    const readStream = createReadStream(filePath);
    return reply.send(readStream.pipe(fileDecipher));
  } catch (error) {
    console.error('Error during file decryption or streaming:', error);
    return handleError(reply, 'Invalid file data given', 400);
  }
});

fastify.post('/upload/chunk', async (request, reply) => {
  try {
    const data = await request.file();
    
    if (!data || !data.file) {
      return reply.status(400).send('No chunk provided');
    }

    const chunkNumber = request.headers['x-chunk-number'];
    const totalChunks = request.headers['x-total-chunks'];
    const fileId = request.headers['x-file-id'];
    
    if (!chunkNumber || !totalChunks || !fileId) {
      return reply.status(400).send('Missing chunk metadata');
    }

    const tempChunkDir = path.join(tempDir, fileId);
    
    if (!existsSync(tempChunkDir)) {
      await fs.mkdir(tempChunkDir, { recursive: true });
    }

    await pipeline(
      data.file,
      createWriteStream(path.join(tempChunkDir, chunkNumber))
    );

    if (parseInt(chunkNumber) === parseInt(totalChunks) - 1) {
      try {
        const fileName = randomBytes(16).toString('hex');
        const fileKey = Buffer.from(request.headers['x-encryption-key'], 'hex');
        const fileIV = Buffer.from(request.headers['x-encryption-iv'], 'hex');
        
        const outputStream = createWriteStream(path.join(filesDir, fileName));
        
        const cipher = createCipheriv('aes-256-cbc', fileKey, fileIV);
        
        for (let i = 0; i < parseInt(totalChunks); i++) {
          const chunkPath = path.join(tempChunkDir, i.toString());
          if (!existsSync(chunkPath)) {
            throw new Error(`Missing chunk file: ${i}`);
          }

          const chunkData = await fs.readFile(chunkPath);
          
          if (i < parseInt(totalChunks) - 1) {
            outputStream.write(cipher.update(chunkData));
          } else {
            const finalEncrypted = Buffer.concat([
              cipher.update(chunkData),
              cipher.final()
            ]);
            outputStream.write(finalEncrypted);
          }
          
          await fs.unlink(chunkPath);
        }
        outputStream.end();
        
        await new Promise((resolve, reject) => {
          outputStream.on('finish', resolve);
          outputStream.on('error', reject);
        });
        
        await fs.rmdir(tempChunkDir);

        const dataToEncrypt = JSON.stringify({ 
          fileName: fileName, 
          fileExtension: path.extname(data.filename),
          clientEncrypted: true
        });
        
        const dataIV = randomBytes(16);
        const dataCipher = createCipheriv('aes-256-cbc', Buffer.from(serverSecretKey), dataIV);
        let encryptedFileData = dataCipher.update(dataToEncrypt, 'utf8', 'hex');
        encryptedFileData += dataCipher.final('hex');

        return reply.status(201).send(`${process.env.SERVER_ENV !== 'DEV' && isHttps ? 'https' : 'http'}://${request.headers.host}/download/${fileKey.toString('hex')}/${fileIV.toString('hex')}/${encryptedFileData}/${dataIV.toString('hex')}`);
      } catch (error) {
        console.error('Error processing final chunk:', error);
        await cleanupTempDir(tempChunkDir);
        return reply.status(500).send('Internal server error during final chunk processing');
      }
    }
    return reply.status(200).send(`Received chunk ${parseInt(chunkNumber) + 1}/${parseInt(totalChunks)}`);
  } catch (error) {
    console.error('Chunk upload error:', error);
    return reply.status(500).send('Internal server error during chunk upload');
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
      const httpServer = http.createServer((req, res) => {
        res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
        res.end();
      });
      
      httpServer.listen(80, '0.0.0.0');
      httpServer.listen(80, '::');
      console.log('HTTP redirect server running on port 80 (IPv4 & IPv6)');
    }

    const port = process.env.SERVER_ENV === 'DEV' ? 5000 : isHttps ? 443 : 80;
    await fastify.listen({
      port: port,
      host: '::',
      ipv6Only: false
    });
    console.log(`Server is running on port ${port} (IPv4 & IPv6)`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();

async function handleError(reply, message, statusCode) {
  console.error(message);
  return reply.code(statusCode).view('error.html', { 
    errorMessage: message, 
    maxSize: process.env.SERVER_MAX_UPLOAD, 
    stats: await getStats() 
  });
}

async function cleanupTempDir(tempChunkDir) {
  if (existsSync(tempChunkDir)) {
    const files = await fs.readdir(tempChunkDir);
    for (const file of files) {
      await fs.unlink(path.join(tempChunkDir, file));
    }
    await fs.rmdir(tempChunkDir);
  }
}
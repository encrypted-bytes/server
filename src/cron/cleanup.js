import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);

const LOCK_FILE = path.join(__dirname, '../../cleanup.lock');

export default class cleanup {
    constructor() {
        this.readdir = promisify(fs.readdir);
        this.stat = promisify(fs.stat);
        this.unlink = promisify(fs.unlink);

        this.FILES_DIR = path.join(__dirname, '../../files');
        this.TEMP_DIR = path.join(__dirname, '../../temp');
        this.THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
    }

    async removeOldFiles(dir) {
        const files = await this.readdir(dir);
        const now = Date.now();

        for (const file of files) {
            const filePath = path.join(dir, file);
            const fileStat = await this.stat(filePath);

            const fileAge = now - fileStat.mtimeMs;

            if (fileAge > this.THREE_DAYS) {
                await this.unlink(filePath);
                console.log(`Deleted: ${filePath}`);
            }
        }
    }

    async getDirectoryStats(dir) {
        const files = await this.readdir(dir);
        let totalSizeBytes = 0;
        let fileCount = 0;

        for (const file of files) {
            const filePath = path.join(dir, file);
            const fileStat = await this.stat(filePath);
            totalSizeBytes += fileStat.size;
            fileCount += 1;
        }

        const totalSize = (totalSizeBytes / (1024 ** 3)).toFixed(2);

        return { totalSize, fileCount };
    }

    async run() {
        try {
            try {
                await readFile(LOCK_FILE);
                console.log('Cleanup is busy in the background. Exiting.');
                return;
            } catch (err) {
            }

            await writeFile(LOCK_FILE, 'lock');

            await this.removeOldFiles(this.TEMP_DIR, this.THREE_DAYS);

            const stats = await this.getDirectoryStats(this.FILES_DIR);

            const statsPath = path.join(__dirname, '../stats.json');
            await writeFile(statsPath, JSON.stringify(stats, null, 2));

        } catch (error) {
            console.error('Error during cleanup:', error);
        } finally {
            await unlink(LOCK_FILE);
        }
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const cleanup = new cleanup();
    cleanup.run();
}
document.addEventListener('DOMContentLoaded', () => {
    const e2eMessage = document.getElementById('e2eMessage');
    if (!e2eMessage) {
        console.error('Required DOM element e2eMessage not found');
        return;
    }
    e2eMessage.hidden = false;

    // Check for required Web Crypto API support
    if (!window.crypto || !window.crypto.subtle) {
        console.error('Web Crypto API not supported');
        alert('Your browser does not support secure file encryption. Please use a modern browser.');
        return;
    }

    const form = document.querySelector('form');
    if (!form) {
        console.error('Required form element not found');
        return;
    }

    form.addEventListener('submit', handleFormSubmit);
});

async function handleFormSubmit(e) {
    e.preventDefault();
    e.stopPropagation();

    const elements = {
        progressBar: document.getElementById('uploadProgress'),
        progressText: document.getElementById('progressText'),
        fileInput: document.querySelector('input[type="file"]'),
        textArea: document.querySelector('textarea'),
        submitButton: document.querySelector('button[type="submit"]'),
        statusText: document.getElementById('statusText')
    };

    // Validate all required elements exist
    for (const [key, element] of Object.entries(elements)) {
        if (!element) {
            console.error(`Required DOM element ${key} not found`);
            alert('Page is missing required elements. Please refresh and try again.');
            return;
        }
    }

    if (!elements.fileInput.files[0]) {
        alert('Please select a file');
        return;
    }

    setUploadState(elements, true, 'Starting encrypted upload...');

    try {
        await handleFileUpload(elements);
    } catch (error) {
        console.error('Upload error:', error);
        alert(`Upload failed: ${error.message}`);
    } finally {
        resetUploadState(elements);
    }
}

function setUploadState(elements, disabled, statusMessage) {
    elements.submitButton.disabled = disabled;
    elements.fileInput.disabled = disabled;
    elements.statusText.textContent = statusMessage;
    elements.statusText.hidden = false;
}

function resetUploadState(elements) {
    elements.fileInput.value = null;
    elements.statusText.hidden = true;
    elements.progressText.hidden = true;
    elements.progressBar.hidden = true;
    elements.submitButton.disabled = false;
    elements.fileInput.disabled = false;
}

async function handleFileUpload(elements) {
    const CHUNK_SIZE = 25 * 1024 * 1024; // 25MB chunks
    const file = elements.fileInput.files[0];
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Generate random file ID and encryption materials
    const fileId = generateFileId();
    const { key, iv, exportedKey } = await generateEncryptionMaterials();

    let uploadedBytes = 0;

    for (let chunkNumber = 0; chunkNumber < totalChunks; chunkNumber++) {
        const { chunk, formData } = await prepareChunk(file, chunkNumber, CHUNK_SIZE);
        
        try {
            const response = await uploadChunk(formData, {
                chunkNumber,
                totalChunks,
                fileId,
                exportedKey,
                iv
            });

            uploadedBytes = await handleChunkResponse(response, chunk, uploadedBytes, file, elements, chunkNumber, totalChunks);
        } catch (error) {
            throw new Error(`Chunk ${chunkNumber + 1}/${totalChunks} failed: ${error.message}`);
        }
    }
}

function generateFileId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateEncryptionMaterials() {
    try {
        const key = await window.crypto.subtle.generateKey(
            { name: "AES-CBC", length: 256 },
            true,
            ["encrypt"]
        );
        const iv = window.crypto.getRandomValues(new Uint8Array(16));
        const exportedKey = await window.crypto.subtle.exportKey("raw", key);
        return { key, iv, exportedKey };
    } catch (error) {
        throw new Error(`Failed to generate encryption materials: ${error.message}`);
    }
}

async function prepareChunk(file, chunkNumber, CHUNK_SIZE) {
    const start = chunkNumber * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);
    
    try {
        const encryptedChunk = await chunk.arrayBuffer();
        const formData = new FormData();
        formData.append('file', new Blob([encryptedChunk]), file.name);
        return { chunk, formData };
    } catch (error) {
        throw new Error(`Failed to prepare chunk: ${error.message}`);
    }
}

async function uploadChunk(formData, { chunkNumber, totalChunks, fileId, exportedKey, iv }) {
    const response = await fetch('/upload/chunk', {
        method: 'POST',
        headers: {
            'X-Chunk-Number': chunkNumber.toString(),
            'X-Total-Chunks': totalChunks.toString(),
            'X-File-Id': fileId,
            'X-Encryption-Key': Array.from(new Uint8Array(exportedKey))
                .map(b => b.toString(16).padStart(2, '0')).join(''),
            'X-Encryption-IV': Array.from(iv)
                .map(b => b.toString(16).padStart(2, '0')).join('')
        },
        body: formData
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText);
    }

    return response;
}

async function handleChunkResponse(response, chunk, uploadedBytes, file, elements, chunkNumber, totalChunks) {
    const responseText = await response.text();
    elements.statusText.textContent = responseText;
    
    uploadedBytes += chunk.size;
    updateProgress(uploadedBytes, file.size, elements);

    if (chunkNumber === totalChunks - 1) {
        await handleFinalChunk(file.size, elements, responseText);
    }

    return uploadedBytes;
}

function updateProgress(uploadedBytes, totalSize, elements) {
    const percentComplete = (uploadedBytes / totalSize) * 100;
    const mbUploaded = (uploadedBytes / 1024 / 1024).toFixed(2);
    const mbTotal = (totalSize / 1024 / 1024).toFixed(2);

    elements.progressBar.value = percentComplete;
    elements.progressBar.hidden = false;
    elements.progressText.textContent = `${mbUploaded} MB / ${mbTotal} MB (${percentComplete.toFixed(1)}%)`;
    elements.progressText.hidden = false;
}

async function handleFinalChunk(fileSize, elements, responseText) {
    const mbTotal = (fileSize / 1024 / 1024).toFixed(2);
    elements.progressBar.value = 100;
    elements.progressText.textContent = `${mbTotal} MB / ${mbTotal} MB (100%)`;
    elements.textArea.value = responseText;
    elements.textArea.hidden = false;
    elements.statusText.textContent = 'Upload complete!';
    await new Promise(resolve => setTimeout(resolve, 500));
}
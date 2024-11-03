document.getElementById('e2eMessage').hidden = false;
document.querySelector('form').addEventListener('submit', async function(e) {
    e.preventDefault();
    e.stopPropagation();

    let progressBar = document.getElementById('uploadProgress');
    let progressText = document.getElementById('progressText');
    let fileInput = document.querySelector('input[type="file"]');
    let textArea = document.querySelector('textarea');
    let submitButton = document.querySelector('button[type="submit"]');
    let statusText = document.getElementById('statusText');

    if (!fileInput.files[0]) {
        alert('Please select a file');
        return;
    }

    submitButton.disabled = true;
    fileInput.disabled = true;
    statusText.textContent = 'Starting encrypted upload...';
    statusText.hidden = false;

    try {
        const CHUNK_SIZE = 25 * 1024 * 1024; //TODO figure out a good chunk size
        const file = fileInput.files[0];
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        const fileId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(16).padStart(2, '0')).join('');

        const key = await window.crypto.subtle.generateKey(
            { name: "AES-CBC", length: 256 },
            true,
            ["encrypt"]
        );
        const iv = window.crypto.getRandomValues(new Uint8Array(16));
        const exportedKey = await window.crypto.subtle.exportKey("raw", key);
        
        let uploadedChunks = 0;
        let uploadedBytes = 0;

        for (let chunkNumber = 0; chunkNumber < totalChunks; chunkNumber++) {
            const start = chunkNumber * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);
            const encryptedChunk = await chunk.arrayBuffer();

            const formData = new FormData();
            formData.append('file', new Blob([encryptedChunk]), file.name);

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
                throw new Error(`Failed to upload chunk ${chunkNumber}: ${errorText}`);
            }
            
            const responseText = await response.text();
            statusText.textContent = responseText;
            
            uploadedChunks++;
            uploadedBytes += chunk.size;

            const percentComplete = (uploadedBytes / file.size) * 100;
            progressBar.value = percentComplete;
            progressBar.hidden = false;
            progressText.textContent = `${(uploadedBytes / 1024 / 1024).toFixed(2)} MB / ${(file.size / 1024 / 1024).toFixed(2)} MB (${percentComplete.toFixed(1)}%)`;
            progressText.hidden = false;

            if (chunkNumber === totalChunks - 1) {
                progressBar.value = 100;
                progressText.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB / ${(file.size / 1024 / 1024).toFixed(2)} MB (100%)`;
                textArea.value = responseText;
                textArea.hidden = false;
                statusText.textContent = 'Upload complete!';
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    } catch (error) {
        console.error('Upload error:', error);
        alert('Upload failed. Please try again.');
    } finally {
        fileInput.value = null;
        statusText.hidden = true;
        progressText.hidden = true;
        progressBar.hidden = true;
        submitButton.disabled = false;
        fileInput.disabled = false;
        statusText.hidden = true;
    }
});
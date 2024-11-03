document.querySelector('form').addEventListener('submit', async function(e) {
    e.preventDefault();
    e.stopPropagation();

    let xhr = new XMLHttpRequest();
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

    xhr.open('POST', '/upload', true);
    xhr.setRequestHeader('X-Client-Encrypted', '1');
    xhr.setRequestHeader('return-url', '1');

    try {
        statusText.textContent = 'Your file is being encrypted...';
        statusText.hidden = false;
        
        const key = await window.crypto.subtle.generateKey(
            { name: "AES-CBC", length: 256 },
            true,
            ["encrypt"]
        );
        const iv = window.crypto.getRandomValues(new Uint8Array(16));
        
        const exportedKey = await window.crypto.subtle.exportKey("raw", key);
        
        xhr.setRequestHeader('X-Encryption-IV', Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join(''));
        xhr.setRequestHeader('X-Encryption-Key', Array.from(new Uint8Array(exportedKey)).map(b => b.toString(16).padStart(2, '0')).join(''));

        let isFirstProgress = true;
        
        xhr.upload.onprogress = function(e) {
            if (e.lengthComputable) {
                if (isFirstProgress) {
                    statusText.hidden = true;
                    isFirstProgress = false;
                }
                submitButton.disabled = true;
                fileInput.disabled = true;
                let percentComplete = (e.loaded / e.total) * 100;
                progressBar.value = percentComplete;
                progressBar.hidden = false;
                progressText.textContent = `${(e.loaded / 1024 / 1024).toFixed(2)} MB / ${(e.total / 1024 / 1024).toFixed(2)} MB (${percentComplete.toFixed(1)}%)`;
                progressText.hidden = false;
            }
        };

        xhr.onload = function() {
            if (xhr.status === 201) {
                fileInput.value = null;
                textArea.value = xhr.responseText;
                textArea.hidden = false;
            } else {
                alert('File upload failed. Please try again.');
            }
            progressText.hidden = true;
            progressBar.hidden = true;
            submitButton.disabled = false;
            fileInput.disabled = false;
        };

        const fileBuffer = await fileInput.files[0].arrayBuffer();
        const encryptedContent = await window.crypto.subtle.encrypt(
            { name: "AES-CBC", iv: iv },
            key,
            fileBuffer
        );

        let formData = new FormData();
        const encryptedBlob = new Blob([encryptedContent], { type: 'application/octet-stream' });
        formData.append('file', encryptedBlob, fileInput.files[0].name);
        statusText.textContent = 'Your file is being prepared for upload...';
        xhr.send(formData);
    } catch (error) {
        console.error('Encryption error:', error);
        alert('Encryption failed. Please try again.');
        submitButton.disabled = false;
        fileInput.disabled = false;
        statusText.hidden = true;
    }
});
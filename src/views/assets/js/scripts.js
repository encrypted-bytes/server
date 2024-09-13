document.querySelector('form').addEventListener('submit', function(e) {
    e.preventDefault();
    e.stopPropagation();
    let xhr = new XMLHttpRequest();
    let progressBar = document.getElementById('uploadProgress');
    let progressText = document.getElementById('progressText');
    let fileInput = document.querySelector('input[type="file"]');
    let textArea = document.querySelector('textarea');
    let submitButton = document.querySelector('button[type="submit"]');
    xhr.open('POST', '/upload', true);
    xhr.setRequestHeader('return-url', '1');
    
    xhr.upload.onprogress = function(e) {
        if (e.lengthComputable) {
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
        progressBar.value = 0;
        submitButton.disabled = false;
        fileInput.disabled = false;
    };
    
    xhr.send(new FormData(this));
});
document.querySelector('form').addEventListener('submit', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var xhr = new XMLHttpRequest();
    var progressBar = document.getElementById('uploadProgress');
    var progressText = document.getElementById('progressText');
    xhr.open('POST', '/upload', true);
    xhr.setRequestHeader('User-Agent', 'curl');
    
    xhr.upload.onprogress = function(e) {
        if (e.lengthComputable) {
            var percentComplete = (e.loaded / e.total) * 100;
            progressBar.value = percentComplete;
            progressBar.hidden = false;
            progressText.textContent = `${(e.loaded / 1024 / 1024).toFixed(2)} MB / ${(e.total / 1024 / 1024).toFixed(2)} MB (${percentComplete.toFixed(1)}%)`;
            progressText.hidden = false;
        }
    };
    
    xhr.onload = function() {
        if (xhr.status === 201) {
            document.querySelector('textarea').value = xhr.responseText;
            document.querySelector('textarea').hidden = false;
        } else {
            alert('File upload failed. Please try again.');
        }
        progressText.hidden = true;
        progressBar.hidden = true;
        progressBar.value = 0;
    };
    
    xhr.send(new FormData(this));
});
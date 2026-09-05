// DEV-ONLY STUB for window.maskImageFile (Teammate 1's masking.js).
// Real build: T1's masking.js defines window.maskImageFile and this file is
// removed from manifest.json. Activates ONLY when window.maskImageFile is
// absent, so it can never shadow the real implementation.
// Contract: (file: File) => Promise<Blob> — masked PNG blob.
(function () {
  if (typeof window.maskImageFile === 'function') return;
  window.__KAVACH_MASK_STUB = true;
  window.maskImageFile = async function (file) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    // Labeled stub behaviour: black-box the central band (stands in for
    // real PII-region masking until T1's masking.js lands).
    ctx.fillStyle = '#000';
    ctx.fillRect(0, canvas.height * 0.35, canvas.width, canvas.height * 0.3);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 24px system-ui';
    ctx.fillText('KAVACH-STUB-MASK', 16, canvas.height * 0.52);
    if (bitmap.close) bitmap.close();
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('stub toBlob failed'))), 'image/png')
    );
  };
  console.info('[KAVACH] masking STUB active — replace with T1 masking.js');
})();

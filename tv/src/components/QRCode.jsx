import { useEffect, useRef } from 'preact/hooks';
import '../../../src/vendor/qrcode.js';

/** QR code drawn by the website's vendored encoder (window.TVQRCode). */
export function QRCode({ text, onError }) {
  const ref = useRef(null);
  useEffect(() => {
    try { window.TVQRCode(ref.current, text); } catch (e) { if (onError) onError(e); }
  }, [text]);
  return <canvas ref={ref} class="qr" role="img" aria-label="用手機相機掃描這個配對 QR Code" />;
}

// AIHub Video-in-Text - Vercel Serverless Function: tải video/audio từ 1 link trực tiếp
// rồi chuyển tiếp qua OpenAI Whisper để lấy văn bản đầy đủ.
// Route: POST /api/transcribe-url  body: { url, apiKey, language? }
//
// Lý do cần hàm này: trình duyệt không thể fetch() trực tiếp file từ nhiều
// server khác do CORS, nên phải tải hộ ở phía server rồi mới gửi tiếp cho Whisper.
// API key OpenAI đi qua đây chỉ được dùng để gọi OpenAI ngay trong request này,
// không được lưu lại ở đâu cả.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const MAX_BYTES = 25 * 1024 * 1024; // giới hạn của OpenAI Whisper

const EXT_BY_CONTENT_TYPE = {
  'video/mp4': 'mp4', 'audio/mp4': 'm4a', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'audio/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/wave': 'wav', 'video/x-msvideo': 'avi', 'audio/ogg': 'ogg', 'video/ogg': 'ogv'
};

function extFromUrl(url) {
  const match = /\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}

function json(body, status) {
  return Response.json(body, { status: status || 200, headers: CORS_HEADERS });
}

async function fetchWithLimit(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('Không tải được link (HTTP ' + res.status + ')');

  const declaredLen = Number(res.headers.get('content-length') || 0);
  if (declaredLen && declaredLen > MAX_BYTES) {
    throw new Error('File vượt quá 25MB (giới hạn của Whisper).');
  }

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  if (!res.body) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error('File vượt quá 25MB (giới hạn của Whisper).');
    return { blob: new Blob([buf], { type: contentType }), contentType };
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > MAX_BYTES) {
      reader.cancel();
      throw new Error('File vượt quá 25MB (giới hạn của Whisper).');
    }
    chunks.push(value);
  }
  return { blob: new Blob(chunks, { type: contentType }), contentType };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return json({ success: false, error: 'method not allowed' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ success: false, error: 'invalid json' }, 400);
    }

    const url = (body.url || '').trim();
    const apiKey = (body.apiKey || '').trim();
    const language = (body.language || '').trim();

    if (!/^https?:\/\//i.test(url)) {
      return json({ success: false, error: 'Link không hợp lệ.' }, 400);
    }
    if (!apiKey.startsWith('sk-')) {
      return json({ success: false, error: 'OpenAI API Key không hợp lệ.' }, 400);
    }

    let blob, contentType;
    try {
      const fetched = await fetchWithLimit(url);
      blob = fetched.blob;
      contentType = fetched.contentType;
    } catch (err) {
      return json({ success: false, error: err.message }, 400);
    }

    const ext = EXT_BY_CONTENT_TYPE[contentType.split(';')[0].trim().toLowerCase()] || extFromUrl(url) || 'mp4';
    const form = new FormData();
    form.append('file', blob, 'video.' + ext);
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');
    if (language) form.append('language', language);

    let whisperRes;
    try {
      whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey },
        body: form
      });
    } catch (err) {
      return json({ success: false, error: 'Không gọi được OpenAI: ' + err.message }, 502);
    }

    if (!whisperRes.ok) {
      let msg = 'Lỗi OpenAI (HTTP ' + whisperRes.status + ')';
      try {
        const j = await whisperRes.json();
        if (j.error && j.error.message) msg = j.error.message;
      } catch (e) {}
      return json({ success: false, error: msg }, 502);
    }

    const text = (await whisperRes.text()).trim();
    return json({ success: true, text });
  }
};

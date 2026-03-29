import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

const JID = 'web:main';

const CHAT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${ASSISTANT_NAME} — Web Chat</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1a1a2e;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;height:100vh;display:flex;flex-direction:column}
#header{background:#16213e;padding:12px 20px;border-bottom:1px solid #0f3460;display:flex;align-items:center;gap:10px}
#header h1{font-size:18px;font-weight:600;color:#e94560}
#status{font-size:12px;color:#888;margin-left:auto}
#messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}
.msg{max-width:80%;padding:10px 14px;border-radius:12px;line-height:1.5;word-wrap:break-word;white-space:pre-wrap;font-size:14px}
.msg.user{align-self:flex-end;background:#0f3460;color:#e0e0e0;border-bottom-right-radius:4px}
.msg.bot{align-self:flex-start;background:#222;color:#e0e0e0;border-bottom-left-radius:4px}
.msg code{background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px;font-size:13px}
.msg pre{background:rgba(0,0,0,0.3);padding:8px;border-radius:6px;overflow-x:auto;margin:6px 0}
.msg pre code{background:none;padding:0}
.msg strong{font-weight:700}
#typing{padding:4px 20px;font-size:12px;color:#888;min-height:20px}
.typing-dots span{animation:blink 1.4s infinite both}
.typing-dots span:nth-child(2){animation-delay:0.2s}
.typing-dots span:nth-child(3){animation-delay:0.4s}
@keyframes blink{0%,80%,100%{opacity:0.2}40%{opacity:1}}
#input-area{background:#16213e;padding:12px;border-top:1px solid #0f3460;display:flex;gap:8px}
#input{flex:1;background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;border-radius:8px;padding:10px 14px;font-size:14px;resize:none;min-height:42px;max-height:200px;font-family:inherit;outline:none}
#input:focus{border-color:#e94560}
#send{background:#e94560;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:14px;cursor:pointer;font-weight:600}
#send:hover{background:#c73e54}
#send:disabled{opacity:0.5;cursor:not-allowed}
@media(max-width:600px){.msg{max-width:90%}#input-area{padding:8px}#send{padding:10px 14px}}
</style>
</head>
<body>
<div id="header"><h1>${ASSISTANT_NAME}</h1><span id="status">connecting...</span></div>
<div id="messages"></div>
<div id="typing"></div>
<div id="input-area">
<textarea id="input" rows="1" placeholder="Type a message..." autofocus></textarea>
<button id="send">Send</button>
</div>
<script>
const msgs=document.getElementById('messages');
const input=document.getElementById('input');
const sendBtn=document.getElementById('send');
const status=document.getElementById('status');
const typingEl=document.getElementById('typing');
let ws,retryDelay=500;

function connect(){
  const proto=location.protocol==='https:'?'wss:':'ws:';
  ws=new WebSocket(proto+'//'+location.host+'/ws');
  ws.onopen=()=>{status.textContent='connected';status.style.color='#4ecca3';retryDelay=500};
  ws.onclose=()=>{status.textContent='disconnected';status.style.color='#e94560';setTimeout(connect,retryDelay);retryDelay=Math.min(retryDelay*2,30000)};
  ws.onerror=()=>ws.close();
  ws.onmessage=(e)=>{
    const data=JSON.parse(e.data);
    if(data.type==='message'){addMsg(data.text,'bot');typingEl.innerHTML=''}
    else if(data.type==='typing'){typingEl.innerHTML='<span class="typing-dots">${ASSISTANT_NAME} is typing<span>.</span><span>.</span><span>.</span></span>'}
  };
}

function renderMd(t){
  // code blocks
  t=t.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g,(_,c)=>'<pre><code>'+esc(c.trim())+'</code></pre>');
  // inline code
  t=t.replace(/\`([^\`]+)\`/g,(_,c)=>'<code>'+esc(c)+'</code>');
  // bold
  t=t.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
  return t;
}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

function addMsg(text,cls){
  const d=document.createElement('div');
  d.className='msg '+cls;
  if(cls==='bot'){d.innerHTML=renderMd(text)}else{d.textContent=text}
  msgs.appendChild(d);
  msgs.scrollTop=msgs.scrollHeight;
}

function send(){
  const text=input.value.trim();
  if(!text||!ws||ws.readyState!==1)return;
  ws.send(JSON.stringify({type:'message',text}));
  addMsg(text,'user');
  input.value='';
  input.style.height='auto';
}

sendBtn.onclick=send;
input.onkeydown=(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}};
input.oninput=()=>{input.style.height='auto';input.style.height=input.scrollHeight+'px'};
connect();
</script>
</body>
</html>`;

export class WebChatChannel implements Channel {
  name = 'webchat';

  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private opts: ChannelOpts;
  private port: number;

  constructor(port: number, opts: ChannelOpts) {
    this.port = port;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(CHAT_HTML);
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', clients: this.clients.size }));
        return;
      }
      // Serve test reports as static HTML files
      if (req.method === 'GET' && req.url?.startsWith('/reports/')) {
        const REPORTS_DIR = '/home/nanoclaw/reports';
        const fileName = path.basename(req.url.split('?')[0].split('#')[0]);
        if (!fileName || fileName.includes('..')) {
          res.writeHead(400);
          res.end('Bad request');
          return;
        }
        const filePath = path.join(REPORTS_DIR, fileName);
        try {
          const html = fs.readFileSync(filePath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch {
          res.writeHead(404);
          res.end('Report not found');
        }
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });

    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      logger.info(
        { clients: this.clients.size },
        'WebChat client connected',
      );

      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.type === 'message' && data.text) {
            const now = new Date().toISOString();
            const msgId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

            this.opts.onChatMetadata(JID, now, 'Web Chat', 'webchat', false);

            this.opts.onMessage(JID, {
              id: msgId,
              chat_jid: JID,
              sender: 'web-user',
              sender_name: 'Marc',
              content: data.text,
              timestamp: now,
              is_from_me: false,
            });

            logger.info({ msgId }, 'WebChat message received');
          }
        } catch (err) {
          logger.warn({ err }, 'WebChat: invalid message');
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.debug(
          { clients: this.clients.size },
          'WebChat client disconnected',
        );
      });

      ws.on('error', (err) => {
        logger.warn({ err }, 'WebChat WebSocket error');
        this.clients.delete(ws);
      });
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, '0.0.0.0', () => {
        logger.info({ port: this.port }, 'WebChat server listening');
        console.log(`\n  Web Chat: http://0.0.0.0:${this.port}\n`);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    const payload = JSON.stringify({ type: 'message', text });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
    logger.info(
      { clients: this.clients.size, length: text.length },
      'WebChat message sent',
    );
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async disconnect(): Promise<void> {
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    return new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          logger.info('WebChat server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  async setTyping(_jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const payload = JSON.stringify({ type: 'typing' });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }
}

registerChannel('webchat', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['WEBCHAT_ENABLED', 'WEBCHAT_PORT']);
  const enabled =
    process.env.WEBCHAT_ENABLED || envVars.WEBCHAT_ENABLED || '';
  if (enabled !== 'true') {
    logger.debug('WebChat: not enabled (set WEBCHAT_ENABLED=true)');
    return null;
  }
  const port = parseInt(
    process.env.WEBCHAT_PORT || envVars.WEBCHAT_PORT || '3000',
    10,
  );
  return new WebChatChannel(port, opts);
});

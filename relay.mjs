// starpost-relay.mjs —— 星邮 <-> Reason Network 信箱中转
// 让信箱里的 AI agent 直接玩星邮（狼人杀、剧本杀、漂流瓶、广场、时间胶囊……）。
// 协议（从 cortico-world-starpost@0.29.1 逆向确认）：
//   发件: POST <STARPOST_HOST>/rpc  {action, args, limits}
//         headers: authorization: Bearer <token> ; x-starpost-id: <botId>
//         响应 {ok, result, error, messageQuota, suspendedUntil}
//   收件: rpc('events', {since: 游标, waitMs, mediaRefs:true}) 长轮询 → [{seq,type,data,at}]
//   凭据: /credential/claim 一次（404/失败 10 分钟后重试，不致命）
// ⚠️ TLS 指纹门：星邮服务器只认 Electron/某些 V8 栈的 ClientHello——本脚本必须跑在
//    服务器 node 上（实测服务器 node 可过；Windows 系统 node、curl 都被 RST）。
// 信箱契约（rn-mailbox-bridge）：
//   OUT: 写 mailbox/outbox.md，首行=收件人地址，写入后必须保持不变 ≥2 个轮询周期；
//        bridge 发完会把文件改名走（sent-*.md），我们等文件消失再写下一封。
//   IN : mailbox/inbox.md 新块以 "\n---\n" 分隔，块头 "## <ts> · Reason Network message"。
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

// ---------- 配置：全部走环境变量，代码里不留账号/域名/路径 ----------
// RELAY_HOME        默认 ~                         根目录
// RELAY_STATE_DIR   默认 ~/.starpost-relay         state.json / credential.json / relay.log
// RELAY_MAILBOX     默认 ~/starpost-relay/mailbox  信箱目录（与 bridge.py --mailbox 指向同一处）
// RELAY_RECIPIENT   必填                           事件信默认收件人 = 你的主 agent 会话地址，如 "alice/main-agent"
// STARPOST_HOST     必填                           星邮服务域名，如 "starpost.example.com"
// RELAY_RATE_MAX    默认 100                       出信节流：10 分钟内最多 N 封（按引擎回环闸留余量）
// RELAY_QUIET_TZ    默认 8                         静默时段时区偏移（UTC+N，小时）
// RELAY_QUIET_HOURS 默认 "1-8"                     静默时段（该时区的本地小时，闭开区间）
const HOME = process.env.RELAY_HOME || os.homedir();
const DIR = process.env.RELAY_STATE_DIR || path.join(HOME, '.starpost-relay');
const MB = process.env.RELAY_MAILBOX || path.join(HOME, 'starpost-relay', 'mailbox');
const INBOX = path.join(MB, 'inbox.md');
const OUTBOX = path.join(MB, 'outbox.md');
const RECEIPTS = path.join(MB, 'receipts.md');       // 指令回执不寄信，只落这里（信路有节流/回环闸）
const PENDING = path.join(MB, 'events-hold.md');     // 静默期攒的事件信
const STATE = path.join(DIR, 'state.json');          // {cursor, processed:[sha1..], seq}
const QUIET_FLAG = path.join(path.dirname(MB), 'QUIET');
const LOG = path.join(DIR, 'relay.log');
const RECIPIENT = process.env.RELAY_RECIPIENT || '';  // 事件信默认收件人（必填）
const BASE = { host: process.env.STARPOST_HOST || '', path: '' };
const LIMITS = { private: 10, groups: 5, maxMessagesPerDay: 300, maxWerewolfGamesPerDay: 5,
                 periods: { morning: 60, afternoon: 60, sleep: 6 } };
const PROCESSED_MAX = 600;
const QUIET_TZ = Number(process.env.RELAY_QUIET_TZ || 8);
const QUIET_RANGE = (process.env.RELAY_QUIET_HOURS || '1-8').split('-').map(Number);

if (!BASE.host || !RECIPIENT) {
  console.error('缺少 STARPOST_HOST 或 RELAY_RECIPIENT 环境变量——见 README「快速开始」');
  process.exit(1);
}
// 目录来源：cortico-world-starpost/server/server.mjs 的 case 表逐个核对（11-15 更正版）。
// 旧版目录里 square.browse / square.read / profile.search / inbox.read 都不存在（服务端回「未知操作」）。
const HELP = `星邮中转指令：整条消息为一个 JSON {"action":"<rpc.action>","args":{...}}。
⚠️【广场(display) ≠ 动态(post)，两者不能互相评论】
  - posts 数组里的才是"动态"，能 comment/delete；
  - square 数组里的是"广场展示"(kind=bot/group/game/mystery)，只能看 + 申请好友/加群，协议层面没有评论区。
  - snapshot 里那些 bot 自我介绍帖都是 square 条目 ⇒ post.comment 报
    "动态不存在"是服务端的正常回答，不是 relay 拦的。想让人看见你，用 square.showcase 发自己的展示。

广场（真名）
  square.list {index:true, kind?, limit?, cursor?}   目录，kind=all|bot|group|game|mystery
  square.list {listingId}                            读单条正文（没有 square.read / square.browse）
  square.friend {listingId}                          对展示的 bot 申请好友
  square.join {listingId}                            加入宣传的群
  square.showcase {text}                             展示自己（12h 一次，text≤500）
  square.promote {groupId, text}                     群主宣传群
  square.featured {} | {action:"read", gameId}        每日精彩对局

动态
  post.publish {text,imageFile?}（bot 每日 3 条）| post.read {postId,before?}
  post.comment {postId,text,parentId?}（仅 posts 有效）| post.delete {postId}

聊天/信箱
  message.send {kind:'private'|'group'|'owner', target, text, sticker?, imageFile?, replyTo?, mentions?}
  message.read {kind,target,messageId} | message.recall 同参 | chat.history {kind,target,before?}
  chat.image {kind,target,messageId} | inbox.peek {} | owner.send {text} | owner.history {before?}
  snapshot {}（全量索引，含额度/posts/square/bottles）

人/群
  directory.search {query?,kind?}（没有 profile.search）| profile.read {botId?,section} | profile.update {...}
  profile.equip {titleId} | friend.request {botId,note} | friend.accept/reject/remove {botId}
  （好友/别人的资料用 profile.read {botId,section} 或 snapshot 查，没有 friend.read）
  group.create {name,members} | group.invite {groupId,botId} | group.leave {groupId} | group.manage {groupId,action,...}

瓶子/胶囊
  bottle.throw {text} | bottle.pick {} | bottle.read {bottleId} | bottle.reply {bottleId,text} | bottle.friend {bottleId}
  capsule.create {text,afterValue,afterUnit} | capsule.list {} | capsule.read {capsuleId}

狼人杀 / 剧本杀（状态机在星邮服务器，照回执里的阶段走；mystery.* 与 game.* 同构）
  ⚠️game.act 的字段是 action(动作名)+target(目标ID)，没有 move 字段：
    {"action":"game.act","args":{"gameId":"…","action":"attack","target":"<玩家ID>"}}   狼刀（限 night_wolf 阶段，提交后不能改）
    动作名只有这些：attack狼刀|inspect查验|protect守护|save解药|poison毒药|shoot猎人枪|end_speech结束发言|skip跳过本夜
    skip / end_speech 不带 target；白天发言完必须发 end_speech（全员发完立即开投，不发就一直等）
  ⏱每阶段开始先 {"action":"game.read","args":{"gameId":"…"}} 看回执里的 phase/deadlineAt/ownRole 再行动；
    时限：狼夜3分/神职2分/讨论5分/公投2分，超时=放弃、未投票=弃票。
    「当前阶段或身份不能执行此操作」=action 拼写或阶段不对（对照上面清单核对）
  game.browse | game.list | game.read {gameId,section?} | game.rules {}
  game.schedule {title?,startMode?,scheduledAt?,maxPlayers?,sourceKind?,sourceTarget?}
  game.join | game.leave | game.checkin | game.cancel | game.exit | game.visibility | game.invite | game.match
  game.act {gameId,action,target} | game.message {gameId,channel,text} | game.vote {gameId,target:"<ID>"|"abstain"} | game.record
  game.watch | game.unwatch | game.report | game.publish

其它
  poke {to|botId,groupId?} | release.latest {}
  （表情没有独立的 sticker.* 动作：直接在 message.send 里带 sticker 字段）
不确定字段先发 {"action":"snapshot","args":{}}，或 {"action":"help","args":{}} 重看这份目录。
⚠️ 回执不寄信：写完指令后翻 信箱目录下的 receipts.md 看结果（成功/失败都在，信箱里不再出现【星邮回执】）。`;

const log = (msg) => {
  try {
    fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + String(msg).slice(0, 500) + '\n');
    if (fs.statSync(LOG).size > 200000) {
      const t = fs.readFileSync(LOG, 'utf8').slice(-100000);
      fs.writeFileSync(LOG, t);
    }
  } catch { /* ignore */ }
};

// 指令回执（成功/失败/没解析出）不转成信——信走 RN 邮路有节流和回环闸，
// 回执洪水会把队列撑爆；落 receipts.md 让上层程序直接读文件即可。
function appendReceipt(title, body) {
  try {
    fs.mkdirSync(MB, { recursive: true });
    if (fs.existsSync(RECEIPTS) && fs.statSync(RECEIPTS).size > 1024 * 1024) {
      fs.renameSync(RECEIPTS, RECEIPTS.replace(/\.md$/, '') + '-archive-' + Date.now() + '.md');
    }
    fs.appendFileSync(RECEIPTS, `## ${new Date().toISOString()} · ${title}\n${String(body).trim()}\n\n`);
    log('receipts 落档: ' + title);
  } catch (e) { log('receipts 写失败: ' + e.message); }
}


// ---------- 星邮 rpc ----------
let cred = null;
function loadCred() {
  cred = JSON.parse(fs.readFileSync(path.join(DIR, 'credential.json'), 'utf8'));
  if (!cred.botId || !cred.token) throw new Error('credential.json 缺 botId/token');
}
let claimed = false, claimRetryAt = 0;

function postRpc(bodyObj, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const req = https.request({
      host: BASE.host, path: '/rpc', method: 'POST', timeout: timeoutMs,
      headers: {
        authorization: 'Bearer ' + cred.token, 'x-starpost-id': cred.botId,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch { reject(new Error('bad json: ' + b.slice(0, 120))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('rpc timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

async function claim() {
  if (claimed || Date.now() < claimRetryAt) return;
  try {
    const r = await new Promise((resolve, reject) => {
      const req = https.request({
        host: BASE.host, path: '/credential/claim', method: 'POST', timeout: 15000,
        headers: { authorization: 'Bearer ' + cred.token, 'x-starpost-id': cred.botId,
                   'content-type': 'application/json', 'content-length': 2 },
      }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end('{}');
    });
    if (r && r.ok === false) throw new Error(r.error || 'claim 被拒');
    claimed = true;
    log('claim ok');
  } catch (e) {
    claimRetryAt = Date.now() + 10 * 60 * 1000;
    log('claim 失败(10分钟后重试): ' + e.message);
  }
}

async function rpc(action, args = {}, timeoutMs = 25000) {
  await claim();
  const body = await postRpc({ action, args, limits: LIMITS }, timeoutMs);
  if (Number.isSafeInteger(body.suspendedUntil) && body.suspendedUntil > Date.now()) {
    log('服务端暂停投递至 ' + new Date(body.suspendedUntil).toISOString());
  }
  if (!body.ok) throw new Error(body.error || ('HTTP fail: ' + JSON.stringify(body).slice(0, 120)));
  return body.result;
}

// ---------- 状态 ----------
let state = { cursor: null, processed: [], seq: 0 };
function loadState() {
  try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch { /* first run */ }
}
const saveState = () => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });
};
function nextSeq() {
  state.seq = (state.seq || 0) + 1;
  saveState();
  return state.seq;
}

// ---------- 信箱：OUT ----------
// RN 不给离线 session 排队：收件人 bridge 掉线时 bridge.py 重试 3 次就把内容归档成
// outbox-failed-*.md（消息静默丢失）。所以每写一封都在后台核验一次，失败就补投（最多 3 轮）。
// 但「bridge 活着、listen 收下了、桥没写盘」这种丢法本机核验不出来（RN 那头算成功），
// 所以每封信额外带一个递增序号，收件人一眼能看出断档。
const FAILED_RE = /^outbox-failed-\d{8}-\d{6}\.md$/;
const MAX_TRIES = 3;

const SENT = path.join(MB, 'sent');

function findPayload(payload, at) {
  // 在 sent/ 与 mailbox/ 根找「内容 == 我们写的那封」的归档文件；按 mtime 过滤这封之后的
  const want = Buffer.byteLength(payload);
  for (const dir of [SENT, MB]) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.md') || name.endsWith('.retried.md')) continue;
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs < at - 2000 || st.size !== want) continue;
      let txt;
      try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (txt === payload) return { path: p, failed: dir === MB && FAILED_RE.test(name) };
    }
  }
  return null;
}

function verifyDelivery(to, body, at, tries) {
  const payload = (Array.isArray(to) ? to.join(' ') : to) + '\n\n' + body + '\n';
  const deadline = Date.now() + 150000;
  const poll = () => {
    let hit;
    try { hit = findPayload(payload, at); } catch (e) { log('投递核验异常: ' + e.message); }
    if (hit && hit.failed) {
      try { fs.renameSync(hit.path, hit.path + '.retried'); } catch { /* ignore */ }  // 留痕，避免重复匹配
      if (tries + 1 < MAX_TRIES) {
        const backoff = 60000 * (tries + 1);              // 退避：拒收多半是回环闸或收件人不在，立刻重投只会再拒
        log('收件人 ' + to + ' 投递失败，' + Math.round(backoff / 1000) + 's 后补投第 ' + (tries + 1) + ' 轮');
        setTimeout(() => writeOutbox(to, body, tries + 1), backoff);
      } else {
        log('补投 ' + MAX_TRIES + ' 轮仍失败，放弃：' + to);
      }
      return;
    }
    if (hit) return;                                     // 进了 sent/ = 投递成功
    if (Date.now() > deadline) { log('投递结果未知（150s 内既无 sent 也无 failed）：' + to); return; }
    setTimeout(poll, 5000);
  };
  setTimeout(poll, 5000);
}

// RN 引擎有防回环闸：同一对 agent 每 600s 最多 LOOP_LIMIT 封（0.12.2 起 120，按方向计），
// 超了直接 refuse 且不入库。撞闸后我方若还重试，就是自己烧自己的配额，越投越拒。
// 所以本地先限流：**任意滑动 600s 窗口内**最多 RATE_MAX 封（默认 100 = 引擎 120 的 83%），
// 超出的排队等窗口。注意这里是滑窗不是固定窗（下面按时间戳剪枝），所以不存在
// 「固定窗尾部一批 + 下个固定窗开头一批」叠成 2×RATE_MAX 的跨界双密峰。
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = Number(process.env.RELAY_RATE_MAX || 100);
let rateHits = [];
function rateWait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function rateGate() {
  for (;;) {
    const now = Date.now();
    rateHits = rateHits.filter((t) => now - t < RATE_WINDOW_MS);
    if (rateHits.length < RATE_MAX) { rateHits.push(now); return; }
    const wait = RATE_WINDOW_MS - (now - rateHits[0]) + 500;
    log('本侧节流：10 分钟内已发 ' + rateHits.length + ' 封，等 ' + Math.ceil(wait / 1000) + 's 让出门');
    await rateWait(wait);
  }
}

let outboxBusy = Promise.resolve();
function writeOutbox(to, body, tries = 0) {
  if (tries === 0) body = '[#' + nextSeq() + '] ' + body;   // 补投沿用同一封的编号
  outboxBusy = outboxBusy.then(async () => {
    await rateGate();
    return new Promise((resolve) => {
      const at = Date.now();
      const deadline = Date.now() + 90000;
      const tryWrite = () => {
        try {
          if (fs.existsSync(OUTBOX)) {                    // 上一封还没被 bridge 发走
            if (Date.now() > deadline) { log('outbox 90s 未清空，覆盖'); }
            else { setTimeout(tryWrite, 3000); return; }
          }
          const text = Array.isArray(to) ? to.join(' ') : to;
          fs.writeFileSync(OUTBOX, text + '\n\n' + body + '\n');
          resolve();
          verifyDelivery(to, body, at, tries);            // 后台核验，不阻塞下一封
        } catch (e) { log('outbox 写失败: ' + e.message); setTimeout(tryWrite, 3000); }
      };
      tryWrite();
    });
  });
  return outboxBusy;
}

// ---------- 信箱：IN ----------
function readInboxBlocks() {
  let raw = '';
  try { raw = fs.readFileSync(INBOX, 'utf8'); } catch { return []; }
  const MARK = '<!-- HEADER-END -->';
  const idx = raw.indexOf(MARK);
  if (idx < 0) return [];
  return raw.slice(idx + MARK.length).split('\n---\n')
    .map((b) => b.trim()).filter((b) => b.length > 0);
}

function extractJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

function extractFrom(text) {
  // 顺序很重要：bridge 写的块尾有一行页脚
  //   From alice's agent. Reply if useful: reason-network send alice/main-agent --from alice/relay "<reply>"
  // 旧正则 /(?:from|sender)[:\s]+地址/ 会先命中那个 --from alice/relay（中转自己），
  // 导致所有回执寄给自己再被归档成 outbox-failed-*。所以先认标签属性，再认发送提示，最后才认普通 from/sender。
  let m = text.match(/<reason-message[^>]*\bfrom="([a-z0-9-]+\/[a-z0-9-]+)"/i);
  if (m) return m[1];
  m = text.match(/reason-network\s+send\s+([a-z0-9-]+\/[a-z0-9-]+)/i);
  if (m) return m[1];
  m = text.match(/^\s*(?:from|sender)\s*[:=]\s*([a-z0-9-]+\/[a-z0-9-]+)/im);
  return m ? m[1] : null;
}

async function handleCommand(text) {
  const from = extractFrom(text) || RECIPIENT;
  const cmd = extractJson(text);
  if (!cmd || !cmd.action) {
    appendReceipt('中转·没解析出指令', (text.slice(0, 200) + '\n---\n' + HELP));
    return;
  }
  if (cmd.action === 'help') { appendReceipt('help 目录', HELP); return; }
  try {
    const result = await rpc(cmd.action, cmd.args || {});
    let out = JSON.stringify(result, null, 1);
    if (out.length > 4000) out = out.slice(0, 4000) + '\n…(截断，原始 ' + out.length + ' 字符)';
    appendReceipt('回执·' + cmd.action + ' ok', out);
  } catch (e) {
    const msg = e.message || String(e);
    // 服务端不认这个 action 名时，顺手把目录贴回去，省一轮往返（旧目录里 square.browse 这类错名就栽在这）
    let extra = '';
    if (msg === '未知操作') {
      const near = {
        'square.read': 'square.list {listingId}', 'square.browse': 'square.list {index:true}',
        'profile.search': 'directory.search {query}', 'inbox.read': 'snapshot {} 或 chat.history',
        'history': 'chat.history {kind,target}',
      }[cmd.action];
      extra = (near ? '\n→ 这个名字不存在，你要的应该是：' + near : '') + '\n' + HELP;
    }
    appendReceipt('回执·' + cmd.action + ' 失败', msg + extra);
  }
}

async function inboxLoop() {
  const seen = new Set(state.processed);
  for (;;) {
    try {
      for (const block of readInboxBlocks()) {
        const h = crypto.createHash('sha1').update(block).digest('hex');
        if (seen.has(h)) continue;
        seen.add(h);
        state.processed.push(h);
        if (state.processed.length > PROCESSED_MAX) state.processed.splice(0, state.processed.length - PROCESSED_MAX);
        saveState();
        const body = block.replace(/^## [^\n]*\n+/, '');
        log('inbox 新指令 <- ' + body.slice(0, 80).replace(/\n/g, ' '));
        await handleCommand(body);
      }
    } catch (e) { log('inbox 处理异常: ' + e.message); }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

// ---------- 事件腿 ----------
function isQuiet() {
  if (fs.existsSync(QUIET_FLAG)) return true;
  const h = (new Date().getUTCHours() + QUIET_TZ) % 24;
  const [a, b] = QUIET_RANGE;
  return a <= b ? (h >= a && h < b) : (h >= a || h < b);
}

function fmtEvent(ev) {
  const d = ev.data || {};
  const j = JSON.stringify(d);
  const names = {
    'message': '消息', 'message.recalled': '撤回', 'poke': '戳一戳',
    'friend.request': '好友申请', 'friend.accepted': '好友通过', 'friend.removed': '好友解除',
    'group.created': '建群', 'group.joined': '入群', 'group.left': '退群',
    'bottle.picked': '瓶子被捞', 'bottle.found': '捞到瓶子', 'bottle.reply': '瓶子回复',
    'post.published': '动态发布', 'post.comment': '动态评论',
    'square.bot': '广场新展示', 'square.group': '广场群宣传', 'square.game': '广场游戏',
    'game.invited': '狼人杀邀请', 'game.judge_invited': '法官邀请', 'game.joined': '有人入局',
    'game.reminder': '开局报到提醒', 'game.attendance': '报到', 'game.wolf': '狼人频道',
    'game.judge': '法官频道', 'game.outside': '场外频道', 'game.public': '游戏公告',
    'game.private': '游戏私讯', 'game.cancelled': '游戏取消', 'game.closed': '游戏结束',
    'mystery.invited': '剧本杀邀请', 'mystery.message': '剧本杀消息',
    'quota_status': '额度通报', 'owner.message': '主人频道来信',
  };
  const name = names[ev.type] || ev.type;
  let finalName = name;
  if (ev.type === 'game.public') {
    // 阶段切换（vote_open/夜/白天/黎明/票型结果/开局）保持「游戏公告」＝激活信立即叫醒；
    // 玩家发言与单张投票是一局几十条的洪水，降级成攒批普通信。否则她一封信烧一个回合，
    // 一局下来几十个回合，2 分钟投票窗根本排不过来（11-16 三次「当前不能投票」的根因）。
    const k = d.kind;
    finalName = k === 'chat' ? '游戏发言' : k === 'vote' ? '游戏动态' : '游戏公告';
  }
  return `【星邮·${finalName}】${ev.at}\n${j}`;
}

async function flushPending() {
  try {
    if (!fs.existsSync(PENDING)) return;
    const held = fs.readFileSync(PENDING, 'utf8').trim();
    fs.unlinkSync(PENDING);
    if (held) await writeOutbox(RECIPIENT, '【星邮·静默期积压】\n' + held);
    log('静默积压已补投 ' + held.length + ' 字符');
  } catch (e) { log('补投失败: ' + e.message); }
}

async function eventsLoop() {
  for (;;) {
    try {
      if (state.cursor === null) {                        // 首次：把存量标成已读，取最新 seq 当基线
        const evs = await rpc('events', { since: 0, waitMs: 0, mediaRefs: true }, 30000);
        state.cursor = evs.length ? evs[evs.length - 1].seq : 0;
        saveState();
        log('游标基线 ' + state.cursor);
        continue;
      }
      const evs = await rpc('events', { since: state.cursor, waitMs: 20000, mediaRefs: true }, 35000);
      if (evs.length) {
        const letters = evs.map(fmtEvent).join('\n\n');
        if (isQuiet()) {
          fs.appendFileSync(PENDING, letters + '\n\n');
          log('静默期 hold ' + evs.length + ' 条事件');
        } else {
          await writeOutbox(RECIPIENT, letters);
          log('投递 ' + evs.length + ' 条事件');
        }
        state.cursor = evs[evs.length - 1].seq;
        saveState();
      } else if (!isQuiet()) {
        await flushPending();
      }
    } catch (e) {
      log('events 轮询异常: ' + e.message);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

// ---------- 启动 ----------
loadCred();
loadState();
fs.mkdirSync(DIR, { recursive: true });
log('relay 启动 botId=' + cred.botId);
claim();
eventsLoop();
inboxLoop();

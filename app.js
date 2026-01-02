// --- 模組導入 ---
const path = require('path');
// 確保在所有其他程式碼之前載入環境變數
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cookieParser = require('cookie-parser');
// node-fetch v3 是 ESM 模組，需要使用動態 import
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sendResetEmail = require('./sendResetEmail.js'); // 導入模擬的郵件模組
const bookingLocks = new Map();

// --- 應用程式初始化 ---
const app = express();
app.use(express.json({ type: ['application/json', 'application/fhir+json'] }));
app.use(cookieParser());

// --- 常數設定 ---
// 從環境變數讀取設定，並提供合理的預設值
const JWT_SECRET = process.env.JWT_SECRET;
const FHIR_BASE = process.env.FHIR_SERVER_BASE || 'http://203.64.84.177:8080/fhir';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const PORT = process.env.PORT || 3000;

// FHIR Identifier System URL
const EMAIL_SYSTEM = 'http://example.org/fhir/email';
const PASSWORD_SYSTEM = 'http://example.org/fhir/password';

// 檢查 JWT_SECRET 是否已設定，若無則中止程式，避免安全風險
if (!JWT_SECRET) {
  console.error('錯誤：環境變數 JWT_SECRET 未設定。這是一個嚴重安全風險。');
  console.error('請在 .env 檔案中設定一個複雜的隨機字串。');
  process.exit(1);
}

// --- 全域 Debug Middleware ---
app.use((req, res, next) => {
  console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.url}`);
  // 【修正】: 增加 req.body 存在性的檢查，防止 GET 請求等無 body 的情況下出錯
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('  body:', JSON.stringify(req.body, null, 2));
  }
  console.log('  cookies:', req.cookies);
  next();
});

// --- 靜態資源服務 ---
app.use(express.static(path.join(__dirname, 'public')));
app.use('/locales', express.static(path.join(__dirname, 'locales')));
// 根目錄重導向到登入頁面
app.get('/', (req, res) => res.redirect('/login.html'));


// ── 1) Person 註冊 /api/register ────────────────────────────────
app.post('/api/register', async (req, res) => {
  console.log('** 執行 [api/register] **');
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: '姓名、Email 和密碼皆為必填' });
  }

  try {
    // 步驟 1: 檢查 email 是否已存在
    const checkUrl = `${FHIR_BASE}/Person?identifier=${encodeURIComponent(EMAIL_SYSTEM)}|${encodeURIComponent(email)}`;
    const checkRes = await fetch(checkUrl);
    const checkData = await checkRes.json();
    if (checkData.total > 0) {
      return res.status(409).json({ error: '此 Email 已被註冊' });
    }

    // 步驟 2: 建立 Person 資源
    const hashedPassword = await bcrypt.hash(password, 10);
    const person = {
      resourceType: 'Person',
      name: [{ text: name }],
      identifier: [
        { system: EMAIL_SYSTEM, value: email },
        { system: PASSWORD_SYSTEM, value: hashedPassword }
      ],
      telecom: [{ system: 'email', value: email, use: 'home' }]
    };

    const createRes = await fetch(`${FHIR_BASE}/Person`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json' },
      body: JSON.stringify(person)
    });

    if (!createRes.ok) {
      const errorText = await createRes.text();
      throw new Error(`FHIR Server 錯誤: ${createRes.status} ${errorText}`);
    }
    const newPerson = await createRes.json();

    // 步驟 3: 產生一個短效、一次性的 "註冊後權杖" (Post-Registration Token)
    // 這是為了處理 FHIR 伺服器搜尋索引可能存在的延遲問題
    const postRegistrationToken = jwt.sign(
      { id: newPerson.id, purpose: 'post-registration' },
      JWT_SECRET,
      { expiresIn: '5m' } // 5 分鐘內有效
    );
    console.log('  → 產生註冊後權杖，用於即時登入');

    // 步驟 4: 回傳成功訊息和權杖給前端
    res.status(201).json({
      message: '註冊成功',
      personId: newPerson.id,
      postRegistrationToken: postRegistrationToken
    });

  } catch (err) {
    console.error('  [api/register] 發生錯誤:', err);
    res.status(500).json({ error: '註冊過程中發生內部錯誤', detail: err.message });
  }
});

// ── 2) Person 登入 /api/login (修正版) ───────────────────────────
app.post('/api/login', async (req, res) => {
  console.log('** 執行 [api/login] **');
  const { email, password, postRegistrationToken } = req.body;

  try {
    // 【路徑 A: 使用註冊後權杖登入】
    if (postRegistrationToken) {
      console.log('  → 偵測到 postRegistrationToken，執行即時登入');
      try {
        const payload = jwt.verify(postRegistrationToken, JWT_SECRET);
        // 驗證權杖用途是否正確，防止誤用
        if (payload.purpose !== 'post-registration') {
          return res.status(401).json({ error: '權杖用途不符' });
        }
        
        // 驗證通過，直接簽發正式的登入權杖，無需再驗證密碼
        const loginToken = jwt.sign({ id: payload.id }, JWT_SECRET, { expiresIn: '1h' });
        res.cookie('token', loginToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600000 });
        return res.json({ message: '註冊後自動登入成功' });

      } catch (jwtError) {
        return res.status(401).json({ error: '註冊後權杖無效或已過期', detail: jwtError.message });
      }
    }

    // 【路徑 B: 使用 Email 和密碼傳統登入】
    if (!email || !password) {
      return res.status(400).json({ error: '請提供 Email 和密碼' });
    }
    console.log('  → 執行傳統 Email/Password 登入');

    const searchUrl = `${FHIR_BASE}/Person?identifier=${encodeURIComponent(EMAIL_SYSTEM)}|${encodeURIComponent(email)}`;
    console.log(searchUrl);
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (searchData.total === 0) {
      return res.status(401).json({ error: 'Email 或密碼錯誤' });
    }

    const person = searchData.entry[0].resource;
    const hashEntry = person.identifier.find(i => i.system === PASSWORD_SYSTEM);
    if (!hashEntry) {
      return res.status(500).json({ error: '使用者帳號設定不完整，缺少密碼資訊' });
    }

    const isPasswordCorrect = await bcrypt.compare(password, hashEntry.value);
    if (!isPasswordCorrect) {
      return res.status(401).json({ error: 'Email 或密碼錯誤' });
    }

    // 密碼正確，簽發正式登入權杖
    const loginToken = jwt.sign({ id: person.id }, JWT_SECRET, { expiresIn: '1h' });
    res.cookie('token', loginToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600000 });
    res.json({ message: '登入成功' });

  } catch (err) {
    console.error('  [api/login] 發生錯誤:', err);
    res.status(500).json({ error: '登入過程中發生內部錯誤', detail: err.message });
  }
});


// ── 3) 請求重設密碼 /api/request-reset ──────────────────────────
// (已移除重複的 /api/forgot 路由)
app.post('/api/request-reset', async (req, res) => {
  console.log('** 執行 [api/request-reset] **');
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: '請輸入 Email' });
  }
  try {
    // 1. 根據 Email 找出對應的 Person
    const searchUrl = `${FHIR_BASE}/Person?identifier=${encodeURIComponent(EMAIL_SYSTEM)}|${encodeURIComponent(email)}`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    // 即使找不到使用者，也回傳成功訊息，避免攻擊者用來探測哪些 Email 已被註冊
    if (searchData.total === 0) {
      console.log(`  → 找不到 Email: ${email}，但仍回傳成功訊息以策安全`);
      return res.json({ message: '若此 Email 已註冊，您將會收到一封重設密碼的郵件' });
    }

    // 2. 產生有時效性的重設密碼 Token
    const personId = searchData.entry[0].resource.id;
    const resetToken = jwt.sign({ id: personId, purpose: 'password-reset' }, JWT_SECRET, { expiresIn: '15m' });
    const resetLink = `https://myfhirbaser5.ddns.net/reset.html?token=${resetToken}`;

    // 3. 寄出重設連結
    await sendResetEmail(email, resetLink);
    console.log(`  → 已為 ${email} 產生重設連結並模擬寄出`);
    res.json({ message: '若此 Email 已註冊，您將會收到一封重設密碼的郵件' });
  } catch (err) {
    console.error('  [api/request-reset] 發生錯誤:', err);
    res.status(500).json({ error: '請求重設密碼失敗', detail: err.message });
  }
});

// ── 4) 執行密碼重設 /api/reset-password ─────────────────────────
app.post('/api/reset-password', async (req, res) => {
  console.log('** 執行 [api/reset-password] **');
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: '缺少權杖或新密碼' });
  }
  try {
    // 1. 驗證 Token
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.purpose !== 'password-reset') {
      return res.status(401).json({ error: '權杖用途不符' });
    }
    const personId = payload.id;
    console.log(`  → Token 驗證成功，Person ID: ${personId}`);

    // 2. 取得目前的 Person 資源
    const getUrl = `${FHIR_BASE}/Person/${personId}`;
    const getRes = await fetch(getUrl);
    if (!getRes.ok) {
      return res.status(404).json({ error: '找不到對應的使用者' });
    }
    const person = await getRes.json();

    // 3. 更新密碼
    // 先移除舊的密碼 entry
    person.identifier = (person.identifier || []).filter(i => i.system !== PASSWORD_SYSTEM);
    // 加入新的已加密密碼 entry
    person.identifier.push({
      system: PASSWORD_SYSTEM,
      value: await bcrypt.hash(password, 10)
    });

    // 4. 將更新後的 Person 資源存回 FHIR 伺服器
    const putUrl = `${FHIR_BASE}/Person/${personId}`;
    const updateRes = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/fhir+json' },
      body: JSON.stringify(person)
    });

    if (!updateRes.ok) {
      const errorText = await updateRes.text();
      throw new Error(`FHIR Server 更新失敗: ${updateRes.status} ${errorText}`);
    }
    console.log('  → 密碼更新成功');
    res.json({ message: '密碼已成功更新' });
  } catch (err) {
    console.error('  [api/reset-password] 發生錯誤:', err);
    if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: '重設連結無效或已過期', detail: err.message });
    }
    res.status(500).json({ error: '重設密碼失敗', detail: err.message });
  }
});


// ── 5) 取得 Organization 列表 /api/organizations ──────────────────────────
app.get('/api/organizations', async (req, res) => {
  console.log('** [api/organizations] **');
  try {
    // 永遠只抓 name=慈濟大學
    const url = `${FHIR_BASE}/Organization?name=${encodeURIComponent('慈濟大學')}`;
    console.log('  → fetch (hardcoded)', url);
    const r = await fetch(url);
    const b = await r.json();
    // Bundle 內的 entry
    const list = (b.entry||[]).map(e => ({
      id:   e.resource.id,
      name: e.resource.name || '未命名機構'
    }));
    console.log('  org count=', list.length);
    res.json(list);
  } catch (err) {
    console.error('  [api/organizations] error:', err);
    res.status(500).json({ error: err.message });
  }
});



// ── 6) 讀取當前使用者的 Patient (/api/patient) ────────────────
// ── 6) 讀取當前使用者的 Patient (/api/patient) ────────────────
app.get('/api/patient', async (req, res) => {
  console.log('** [api/patient] entry **');
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: '未登入' });

  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token 驗證失敗' }); }
  const personId = payload.id;

  // 支援 ?organizationId=xxx 或 ?managingOrganization=xxx
  const organizationId =
    req.query.organizationId
    || req.query.managingOrganization;

  let url = 
    `${FHIR_BASE}/Patient?identifier=http://example.org/fhir/person|${encodeURIComponent(personId)}`;
  if (organizationId) {
    // ← use `organization` here, not managingOrganization
    url += `&organization=Organization/${encodeURIComponent(organizationId)}`;
    console.log('  → fetching Patient in org:', organizationId);
  } else {
    console.log('  → fetching Patient in any org');
  }

  let fhirRes;
  try { fhirRes = await fetch(url); }
  catch (err) {
    console.error('  → fetch error:', err.message);
    return res.status(502).json({ error:'FHIR 伺服器無法連線' });
  }
  const body = await fhirRes.text();
  if (!fhirRes.ok) {
    console.error('  → FHIR error:', fhirRes.status, body);
    return res.status(502).json({ error: `FHIR 錯誤 ${fhirRes.status}` });
  }

  const bundle = JSON.parse(body);
  console.log('  bundle.total =', bundle.total);
  if (!bundle.total) {
    const msg = organizationId
      ? '此組織尚未註冊 Patient'
      : '尚未建立任何 Patient';
    return res.status(404).json({ error: msg });
  }

  const patient = bundle.entry[0].resource;
  console.log('  found Patient.id =', patient.id);
  return res.json({
    patientId: patient.id,
    orgRef:    patient.managingOrganization?.reference || null
  });
});


// ── 7) 新增 Patient (/api/patient) ─────────────────────────────
app.post('/api/patient', async (req, res) => {
  console.log('** [api/patient POST] body:', req.body);
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error:'未登入' });
  let pid;
  try { pid = jwt.verify(token, JWT_SECRET).id; }
  catch { return res.status(401).json({ error:'Token 驗證失敗' }); }

  const { organizationId, email } = req.body;
  if (!organizationId||!email) return res.status(400).json({ error:'缺少參數' });

  // 防重複
  const chkUrl = `${FHIR_BASE}/Patient?identifier=http://example.org/fhir/person|${encodeURIComponent(pid)}`+
                 `&organization=Organization/${encodeURIComponent(organizationId)}`;
  const chk = await (await fetch(chkUrl)).json();
  if (chk.total>0) return res.status(409).json({ error:'已在此組織註冊' });

  // 建 Patient
  const patient = {
    resourceType:'Patient',
    identifier:[
      { system:'http://example.org/fhir/person', value:pid },
      { system:EMAIL_SYSTEM,            value:email }
    ],
    managingOrganization:{ reference:`Organization/${organizationId}` }
  };
  const r2 = await fetch(`${FHIR_BASE}/Patient`, {
    method:'POST',
    headers:{ 'Content-Type':'application/fhir+json' },
    body: JSON.stringify(patient)
  });
  const text2 = await r2.text();
  if (!r2.ok) return res.status(r2.status).json({ error:text2 });
  const np = JSON.parse(text2);
  res.json({ patientId: np.id });
});

// 8) List Schedules for an organization, with their slots nested inside
// ★★★ CORRECT "SCHEDULE-FIRST" VERSION ★★★
app.get('/api/schedules', async (req, res) => {
  console.log('=== [api/schedules] entry (schedule-first view) ===');
  try {
    // ===================================================================
    // Part 1: Authorization (Unchanged and correct)
    // ===================================================================
    const { organizationId: selectedOrgId } = req.query;
    if (!selectedOrgId) {
      return res.status(400).json({ error: '請在請求中提供 organizationId 參數' });
    }
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: '未登入' });
    let personId;
    try {
      personId = jwt.verify(token, JWT_SECRET).id;
    } catch {
      return res.status(401).json({ error: 'Token 驗證失敗' });
    }
    const patientSearchUrl = `${FHIR_BASE}/Patient?identifier=http://example.org/fhir/person|${encodeURIComponent(personId)}`;
    const patientRes = await fetch(patientSearchUrl);
    if (!patientRes.ok) throw new Error(`Patient search failed: ${patientRes.status}`);
    const patientBundle = await patientRes.json();
    const userRegisteredOrgIds = (patientBundle.entry || []).map(entry => {
      const orgRef = entry.resource?.managingOrganization?.reference;
      return orgRef ? orgRef.split('/')[1] : null;
    }).filter(id => id !== null);

    if (!userRegisteredOrgIds.includes(selectedOrgId)) {
      return res.json({ schedules: [] });
    }
    console.log('  → Authorization successful.');

    // ===================================================================
    // Part 2: Fetch Schedules, then fetch their Slots
    // ===================================================================
    
    // Step A: Find all schedules for the organization.
    const practitionerRefs = await (async () => {
      const prUrl = `${FHIR_BASE}/PractitionerRole?organization=Organization/${selectedOrgId}`;
      const prRes = await fetch(prUrl);
      const prBundle = prRes.ok ? await prRes.json() : { entry: [] };
      return (prBundle.entry || []).map(e => e.resource.practitioner?.reference).filter(Boolean);
    })();
    
    const actorSearchParams = [`Organization/${selectedOrgId}`, ...practitionerRefs];
    const scheduleSearchUrl = `${FHIR_BASE}/Schedule?actor=${actorSearchParams.join(',')}`;
    
    const scheduleRes = await fetch(scheduleSearchUrl);
    const scheduleBundle = scheduleRes.ok ? await scheduleRes.json() : { entry: [] };
    const schedules = scheduleBundle.entry?.map(e => e.resource) || [];

    if (schedules.length === 0) {
      return res.json({ schedules: [] });
    }

    // Step B: For EACH schedule, fetch its free slots and combine the data.
    const result = await Promise.all(schedules.map(async sch => {
      const slotUrl = `${FHIR_BASE}/Slot?schedule=Schedule/${encodeURIComponent(sch.id)}`;
      const slotRes = await fetch(slotUrl);
      const slotBundle = slotRes.ok ? await slotRes.json() : { entry: [] };
      const slots = (slotBundle.entry || []).map(e => ({
        id: e.resource.id,
        start: e.resource.start,
        end: e.resource.end,
        // If the status from the server is missing (undefined), default it to 'free'.
        // This ensures that slots without a specified status are considered available.
        status: e.resource.status || 'free'
      }));
      
      // Return the final nested structure for this schedule
      return {
        scheduleId: sch.id,
        comment: sch.comment || '（無描述）', // This is the activity name
        slots: slots // This is the list of times
      };
    }));

    res.json({ schedules: result });

  } catch (err) {
    console.error('[api/schedules] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 9) 取得指定 Schedule 的 Slot 列表 /api/slots ─────────────────────────────
app.get('/api/slots', async (req, res) => {
  console.log('** [api/slots] entry **');
  try {
    // 驗證 JWT
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: '未登入' });
    try { jwt.verify(token, JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Token 驗證失敗' }); }

    // 取得 scheduleId
    const scheduleId = req.query.scheduleId;
    if (!scheduleId) {
      console.log('  → 缺少 scheduleId');
      return res.status(400).json({ error: '請提供 scheduleId' });
    }

    // 呼叫 FHIR Slot API
    const slotUrl = `${FHIR_BASE}/Slot?schedule=Schedule/${encodeURIComponent(scheduleId)}`;
    console.log('  → fetch Slot →', slotUrl);
    const slotRes = await fetch(slotUrl);
    if (!slotRes.ok) {
      const txt = await slotRes.text();
      console.error('  → FHIR Slot 錯誤', slotRes.status, txt);
      return res.status(502).json({ error: `FHIR 錯誤 ${slotRes.status}` });
    }
    const slotBundle = await slotRes.json();

    // 轉換格式
    const slots = (slotBundle.entry || []).map(e => ({
      id:     e.resource.id,
      start:  e.resource.start,
      end:    e.resource.end,
      status: e.resource.status,
    }));

    console.log(`  → 回傳 ${slots.length} 個 slots`);
    res.json({ slots });
  } catch (err) {
    console.error('[api/slots] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// === 建立/更新 Appointment (安全交易版本) /api/book ===
app.post('/api/book', async (req, res) => {
  console.log('** [api/book] body:', req.body);
  const { slotId } = req.body;
  if (!slotId) {
    return res.status(400).json({ error: '缺少 slotId' });
  }

  if (bookingLocks.has(slotId)) {
    return res.status(409).json({ error: '此時段正在處理中，請稍候' });
  }
  bookingLocks.set(slotId, true);

  try {
    // 1. Verify JWT and get Person ID
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: '未登入' });
    let personId;
    try {
      personId = jwt.verify(token, JWT_SECRET).id;
    } catch {
      return res.status(401).json({ error: 'Token 驗證失敗' });
    }

    // 2. Fetch the new Slot resource
    const newSlotUrl = `${FHIR_BASE}/Slot/${slotId}`;
    const newSlotRes = await fetch(newSlotUrl);
    if (!newSlotRes.ok) return res.status(404).json({ error: '找不到指定的時段 (Slot)' });
    const newSlot = await newSlotRes.json();
    
    // 3. Get the Schedule from the new Slot
    const scheduleRef = newSlot.schedule.reference;
    const scheduleRes = await fetch(`${FHIR_BASE}/${scheduleRef}`);
    if (!scheduleRes.ok) return res.status(404).json({ error: '找不到活動排程 (Schedule)' });
    const schedule = await scheduleRes.json();
    const actorRef = schedule.actor[0].reference; // This will be a Practitioner reference

    // ======================= CORRECTED LOGIC (VERSION 3) =======================
    // 4. Determine the Organization ID from the Practitioner
    if (!actorRef.startsWith('Practitioner/')) {
        throw new Error(`Schedule actor is not a Practitioner as expected: ${actorRef}`);
    }
    const prRoleUrl = `${FHIR_BASE}/PractitionerRole?practitioner=${encodeURIComponent(actorRef)}`;
    console.log('  → Finding PractitionerRole:', prRoleUrl);
    const prRoleRes = await fetch(prRoleUrl);
    if (!prRoleRes.ok) throw new Error(`Could not fetch PractitionerRole for ${actorRef}`);
    
    const prRoleBundle = await prRoleRes.json();
    if (prRoleBundle.total === 0) throw new Error(`Cannot find PractitionerRole for actor ${actorRef}`);
    
    const orgRef = prRoleBundle.entry[0].resource.organization?.reference;
    if (!orgRef) throw new Error(`PractitionerRole for ${actorRef} does not have an organization reference.`);
    
    const organizationId = orgRef.split('/')[1];
    console.log('  → Determined Organization ID:', organizationId);

    // 5. Find the correct, organization-specific Patient resource
    const personIdentifier = `http://example.org/fhir/person|${encodeURIComponent(personId)}`;
    const patientSearchUrl = `${FHIR_BASE}/Patient?identifier=${personIdentifier}&organization=Organization/${organizationId}`;
    console.log('  → Fetching patient with org scope:', patientSearchUrl);
    
    const pSearchRes = await fetch(patientSearchUrl);
    if (!pSearchRes.ok) throw new Error(`搜尋 Patient 時發生錯誤: ${pSearchRes.statusText}`);
    
    const pSearchBundle = await pSearchRes.json();
    if (!pSearchBundle.total) return res.status(404).json({ error: '在此組織中找不到對應的 Patient 記錄' });
    
    const patientRef = `Patient/${pSearchBundle.entry[0].resource.id}`;
    
    // 6. Find if the user already has a booked appointment for this schedule
    const existingApptUrl = `${FHIR_BASE}/Appointment?patient=${encodeURIComponent(patientRef)}&supporting-information=${encodeURIComponent(scheduleRef)}&status=booked`;
    console.log('  → Checking for existing appointment:', existingApptUrl);
    const existingApptRes = await fetch(existingApptUrl);
    const existingApptBundle = await existingApptRes.json();
    
    // 7. Build the FHIR Transaction Bundle
    const transactionBundle = {
      resourceType: "Bundle",
      type: "transaction",
      entry: []
    };
    let message = '預約成功！';

    // 8. If an existing appointment is found, add operations to cancel it
    if (existingApptBundle.total > 0) {
      console.log('  → Found existing appointment. Will replace it.');
      message = '預約已更新！';
      const oldAppointment = existingApptBundle.entry[0].resource;
      const oldAppointmentRef = `Appointment/${oldAppointment.id}`;
      const oldSlotRef = oldAppointment.slot[0].reference;
      
      if (oldSlotRef) {
        const oldSlotRes = await fetch(`${FHIR_BASE}/${oldSlotRef}`);
        if (oldSlotRes.ok) {
            const oldSlot = await oldSlotRes.json();
            transactionBundle.entry.push({
              resource: { ...oldSlot, status: 'free' },
              request: { method: "PUT", url: oldSlotRef }
            });
        }
      }
      transactionBundle.entry.push({
        request: { method: "DELETE", url: oldAppointmentRef }
      });
    }
    
    // 9. Add operations for the new booking
    transactionBundle.entry.push({
      resource: {
        resourceType: "Appointment",
        status: "booked",
        slot: [{ reference: `Slot/${slotId}` }],
        supportingInformation: [{ reference: scheduleRef }],
        start: newSlot.start,
        end: newSlot.end,
        participant: [
          { actor: { reference: patientRef }, status: "accepted" },
          { actor: { reference: actorRef }, status: "accepted" }
        ]
      },
      request: { method: "POST", url: "Appointment" }
    });

    transactionBundle.entry.push({
      resource: { ...newSlot, status: "busy" },
      request: { method: "PUT", url: `Slot/${slotId}` }
    });

    // 10. Execute the transaction
    console.log('  → Posting transaction bundle to FHIR server');
    const txRes = await fetch(FHIR_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json' },
      body: JSON.stringify(transactionBundle)
    });

    if (!txRes.ok) {
      const errorBody = await txRes.text();
      console.error('  → FHIR Transaction Error:', errorBody);
      throw new Error(`FHIR 交易失敗: ${txRes.statusText}`);
    }

    const txResult = await txRes.json();
    const newAppointmentEntry = txResult.entry.find(e => e.response && e.response.status.startsWith('201'));
    if (!newAppointmentEntry) throw new Error('交易成功，但無法在回應中找到新建立的 Appointment。');
    const newAppointmentId = newAppointmentEntry.response.location.split('/')[1];

    res.json({ message: message, appointmentId: newAppointmentId });

  } catch (err) {
    console.error('[api/book] error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    bookingLocks.delete(slotId);
  }
});


// === 10) 取得當前使用者所有 Appointment (/api/appointments) ===
app.get('/api/appointments', async (req, res) => {
  console.log('** [api/appointments] **');
  try {
    // 1. 驗證 JWT
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: '未登入' });
    let personId;
    try { personId = jwt.verify(token, JWT_SECRET).id; }
    catch { return res.status(401).json({ error: 'Token 驗證失敗' }); }

    // 2. 用 Person ID 查對應的所有 Patient 資源
    const pSearchRes = await fetch(`${FHIR_BASE}/Patient?identifier=http://example.org/fhir/person|${encodeURIComponent(personId)}`);
    const pSearchBundle = await pSearchRes.json();
    if (!pSearchBundle.total) return res.json([]);

    // 3. 取得所有 patient ID 字串，例如 "Patient/123,Patient/456"
    const patientRefs = pSearchBundle.entry.map(e => `Patient/${e.resource.id}`).join(',');

    // 4. 撈取所有相關的 Appointment (REMOVED encodeURIComponent)
    const url = `${FHIR_BASE}/Appointment?patient=${patientRefs}&_count=50&_sort=-date`;
    console.log('  → fetch appointments:', url);
    const aRes = await fetch(url);
    if (!aRes.ok) throw new Error(`FHIR Appointment 取回錯誤 ${aRes.status}`);
    const aBundle = await aRes.json();
    const entries = aBundle.entry || [];
    if (entries.length === 0) return res.json([]);

    // 5. 取得所有相關的 Schedule 名稱
    const scheduleIds = [...new Set(entries
        .map(e => e.resource.supportingInformation?.[0]?.reference)
        .filter(Boolean)
        .map(ref => ref.split('/')[1]))
    ].join(',');

    const scheduleNames = new Map();
    if (scheduleIds) {
        const scheduleUrl = `${FHIR_BASE}/Schedule?_id=${scheduleIds}`;
        console.log(' → fetching schedule names:', scheduleUrl);
        const schRes = await fetch(scheduleUrl);
        if (schRes.ok) {
            const schBundle = await schRes.json();
            (schBundle.entry || []).forEach(e => {
                scheduleNames.set(e.resource.id, e.resource.comment || '（無描述）');
            });
        }
    }

    // 6. 轉換格式並回傳
    const list = entries.map(e => {
      const appt = e.resource;
      const scheduleId = appt.supportingInformation?.[0]?.reference?.split('/')[1] || '';
      return {
        appointmentId: appt.id,
        scheduleId,
        scheduleName: scheduleNames.get(scheduleId) || '（無法載入名稱）',
        start: appt.start,
        end:   appt.end,
        status: appt.status
      };
    });

    res.json(list);
  } catch (err) {
    console.error('[api/appointments] error:', err);
    res.status(500).json({ error: err.message });
  }
});
app.listen(3000, ()=>console.log('Server: http://localhost:3000'));


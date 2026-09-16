
// Atualiza lista de funcionários quando uma aba de cadastro notificar que um novo funcionário foi criado
window.addEventListener('message', function(ev){
  try {
    if (!ev || !ev.data) return;
    if (ev.data.type === 'FUNCIONARIO_ADICIONADO') {
      if (typeof loadPerfis === 'function') {
        loadPerfis();
      } else if (typeof renderPerfis === 'function') {
        renderPerfis();
        if (typeof renderFuncionarios === 'function') renderFuncionarios();
      }
    }
  } catch(e){
    console.error(e);
  }
});

// fallback para garantir que o botão Alterar senha sempre funcione
document.addEventListener('click', function(ev){
  const t = ev.target;
  if (!t) return;
  if (t.id === 'btnAlterarSenha') {
    try { abrirModalAlterarSenha(); } catch(e){ console.error(e); }
  }
});


async function syncPerfilFromFirebase(pid){
  try{
    const remoto = await restaurarDoFirebase(pid);
    if(remoto && remoto.data){
      state.data = remoto.data;
      state.cfg = Object.assign({}, state.cfg, remoto.cfg);
      savePerfil();
      refreshAll();
      refreshSystemStats();
  renderNotifications();
      refreshDbStatus();
    }
  }catch(e){ console.error(e); }
}

async function backupToFirebase(){
  try{
    if(!window.db || !state || !state.perfilId) return;
    const ref = db.collection('perfis').doc(String(getDataOwnerId() || state.perfilId));
    await ref.set({
      data: state.data||{},
      cfg: state.cfg||{},
      updatedAt: new Date().toISOString()
    },{merge:true});
  }catch(e){ console.error(e);}
}

// Evita escrita excessiva no Firestore quando o app salva muitas vezes em sequência.
let _cloudSaveTimer = null;
function scheduleBackupToFirebase(delayMs = 800){
  try{
    if (!window.db) return;
    if (_cloudSaveTimer) clearTimeout(_cloudSaveTimer);
    _cloudSaveTimer = setTimeout(()=>{
      _cloudSaveTimer = null;
      backupToFirebase();
    }, delayMs);
  }catch(e){ console.error(e); }
}

async function ensureCloudPerfilDoc(pid){
  try{
    if(!window.db || !pid) return;
    const ref = db.collection('perfis').doc(String(pid));
    const snap = await ref.get();
    if (snap.exists) return;
    const payload = {
      data: {clientes:[],servicos:[],agenda:[],tx:[],an:[],usuarios:[],backups:[], lastLogin:''},
      cfg: state.cfg || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await ref.set(payload, { merge: true });
  }catch(e){ console.error('Erro ao criar doc inicial do perfil no Firestore', e); }
}

async function restaurarDoFirebase(pid){
  try{
    const ref=db.collection('perfis').doc(String(pid));
    const snap=await ref.get();
    return snap.exists ? snap.data() : null;
  }catch(e){ console.error(e); return null;}
}


/* ======= FIRESTORE (NUVEM 100% + SUBCOLEÇÕES) ======= */
// Estrutura:
// perfis/{uid} (doc) -> cfg, createdAt, updatedAt, lastLogin
// perfis/{uid}/{colecao}/{docId} -> itens (clientes, servicos, agenda, an, tx, usuarios, backups)
//
// OBS: Mantemos state.data em memória para a UI, mas persistimos SEM localStorage.

const CLOUD_COLS = ['clientes','servicos','agenda','an','tx','fiados','usuarios','backups','audit'];

// Guarda os IDs carregados do Firestore para conseguirmos deletar itens removidos.
const _cloudIndex = {
  clientes: new Set(),
  servicos: new Set(),
  agenda: new Set(),
  an: new Set(),
  tx: new Set(),
  usuarios: new Set(),
  backups: new Set(),
  audit: new Set()
};

function _ensureId(item){
  if (!item) return uid();
  if (!item.id) item.id = uid();
  return item.id;
}

async function ensureCloudUserRoot(uidStr){
  if(!window.db || !uidStr) return;
  const ref = db.collection('perfis').doc(String(uidStr));
  const snap = await ref.get();
  if (snap.exists) return;
  await ref.set({
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastLogin: ''
  }, { merge: true });
}

async function loadCloudState(uidStr){
  if(!window.db || !uidStr) throw new Error('Firestore não inicializado ou uid vazio.');
  await ensureCloudUserRoot(uidStr);

  const rootRef = db.collection('perfis').doc(String(uidStr));
  const rootSnap = await rootRef.get();
  const root = rootSnap.exists ? rootSnap.data() : {};
  const cfg = Object.assign({}, state.cfg, (root.cfg || {}));

  const data = {clientes:[],servicos:[],agenda:[],tx:[],fiados:[],an:[],usuarios:[],backups:[],audit:[], lastLogin: root.lastLogin || ''};

  // Carrega cada subcoleção
  for (const col of CLOUD_COLS){
    try{
      if(!cloudColAllowed(col)){ data[col]=[]; _cloudIndex[col]=new Set(); continue; }
      const snap = await rootRef.collection(col).get();
      const arr = [];
      const ids = new Set();
      snap.forEach(doc=>{
        const v = doc.data() || {};
        // garante id
        if (!v.id) v.id = doc.id;
        arr.push(v);
        ids.add(String(v.id));
      });
      data[col] = arr;
      _cloudIndex[col] = ids;
    }catch(e){
      console.error('Erro ao carregar subcoleção', col, e);
      throw e;
    }
  }

  return { cfg, data };
}

async function saveCloudState(uidStr){
  if(!window.db || !uidStr) return;
  const rootRef = db.collection('perfis').doc(String(uidStr));

  // Configuração global e metadados do tenant são gravados apenas pelo administrador.
  const perfilAtual=getPerfilAtual();
  if(perfilAtual && isPerfilAdmin(perfilAtual.id)){
    await rootRef.set({cfg:state.cfg||{},updatedAt:new Date().toISOString(),lastLogin:(state.data&&state.data.lastLogin)?state.data.lastLogin:''},{merge:true});
  }

  // sincroniza cada subcoleção com batch + deletes
  for (const col of CLOUD_COLS){
    try{
      if(!cloudColAllowed(col)) continue;
      const items = (state.data && state.data[col]) ? state.data[col] : [];
      const newIds = new Set();
      const ops = [];
      items.forEach(it=>{ const id=String(_ensureId(it)); newIds.add(id); ops.push(['set',rootRef.collection(col).doc(id),it]); });
      const oldIds = _cloudIndex[col] || new Set();
      oldIds.forEach(oldId=>{ if(!newIds.has(String(oldId))) ops.push(['delete',rootRef.collection(col).doc(String(oldId))]); });
      // Firestore aceita no máximo 500 writes por batch; 400 deixa margem segura.
      for(let i=0;i<ops.length;i+=400){
        const batch=db.batch();
        ops.slice(i,i+400).forEach(op=>{ if(op[0]==='set') batch.set(op[1],op[2],{merge:true}); else batch.delete(op[1]); });
        await batch.commit();
      }
      _cloudIndex[col] = newIds;
    }catch(e){
      console.error('Erro ao salvar subcoleção', col, e);
      throw e;
    }
  }
}

// Debounce para evitar escrita a cada clique
let _cloudSyncTimer = null;
function scheduleCloudSync(delayMs = 600){
  try{
    if (!auth || !auth.currentUser) return;
    const uidStr = getDataOwnerId();
    if (!uidStr) return;
    if (_cloudSyncTimer) clearTimeout(_cloudSyncTimer);
    setSyncStatus('Sincronizando...');
    _cloudSyncTimer = setTimeout(async ()=>{
      _cloudSyncTimer = null;
      try { await saveCloudState(uidStr); setSyncStatus('Salvo'); }
      catch(e){
        setSyncStatus('Erro ao sincronizar', (e&&e.code)?e.code:'');
        console.error(e);
        try{
          const msg = (e && (e.code||e.message)) ? String(e.code||e.message) : '';
          if (/permission-denied/i.test(msg)) toast('Sem permissão para salvar no Firestore. Verifique as Rules.');
        }catch(_){}
      }
    }, delayMs);
  }catch(e){ console.error(e); }
}

// Proxy reativo: qualquer mudança em state.data/state.cfg agenda um sync
function makeReactive(obj, onChange){
  if (!obj || typeof obj !== 'object') return obj;
  const mutators = new Set(['push','pop','shift','unshift','splice','sort','reverse','copyWithin','fill']);
  const cache = new WeakMap();

  const wrap = (target)=>{
    if (!target || typeof target !== 'object') return target;
    if (cache.has(target)) return cache.get(target);

    const p = new Proxy(target, {
      get(t, prop, rec){
        const v = Reflect.get(t, prop, rec);
        if (Array.isArray(t) && typeof v === 'function' && mutators.has(prop)){
          return function(...args){
            const r = v.apply(t, args);
            try{ onChange(); }catch(e){}
            return r;
          };
        }
        return wrap(v);
      },
      set(t, prop, value, rec){
        const r = Reflect.set(t, prop, value, rec);
        try{ onChange(); }catch(e){}
        return r;
      },
      deleteProperty(t, prop){
        const r = Reflect.deleteProperty(t, prop);
        try{ onChange(); }catch(e){}
        return r;
      }
    });
    cache.set(target, p);
    return p;
  };

  return wrap(obj);
}

function attachCloudAutosave(){
  // torna reativo apenas uma vez
  state.data = makeReactive(state.data, ()=>scheduleCloudSync());
  state.cfg  = makeReactive(state.cfg,  ()=>scheduleCloudSync());
}

/* ======= UTIL ======= */
const $ = (sel, ctx=document)=>ctx.querySelector(sel);
const $$ = (sel, ctx=document)=>Array.from(ctx.querySelectorAll(sel));

function setSyncStatus(status, detail=''){
  try{
    let el=document.getElementById('syncStatus');
    if(!el){ el=document.createElement('div'); el.id='syncStatus'; el.setAttribute('aria-live','polite'); Object.assign(el.style,{position:'fixed',right:'12px',bottom:'12px',zIndex:'99999',padding:'7px 10px',borderRadius:'999px',fontSize:'12px',background:'rgba(15,23,42,.92)',color:'#fff',boxShadow:'0 4px 16px rgba(0,0,0,.2)'}); document.body.appendChild(el); }
    el.textContent = status + (detail ? ' — '+detail : '');
    el.title = detail || status;
  }catch(e){ console.error('sync status',e); }
}

// Toast simples (não bloqueia a tela). Se não conseguir injetar, cai no alert.
function toast(msg, ms=2600){
  try{
    let el = document.getElementById('appToast');
    if(!el){
      el = document.createElement('div');
      el.id = 'appToast';
      el.setAttribute('role','status');
      el.setAttribute('aria-live','polite');
      document.body.appendChild(el);
    }
    el.textContent = String(msg||'');
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(()=>el.classList.remove('show'), ms);
  }catch(e){
    try{ alert(msg); }catch(_){}
  }
}
const money = (n, cur='BRL') => new Intl.NumberFormat('pt-BR',{style:'currency',currency:cur}).format(n||0);
const parseMoney = (s) => Number(String(s).replace(/\./g,'').replace(',','.').replace(/[^\d.-]/g,''))||0;
const uid = () => Math.random().toString(36).slice(2)+Date.now().toString(36);
const todayISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Datas vindas de input[type="date"] chegam como "YYYY-MM-DD".
// Em Safari/iOS, new Date("YYYY-MM-DD") é interpretado como UTC e pode
// renderizar/salvar um dia anterior dependendo do fuso.
function _isISODateOnly(v){
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
function _parseISODateOnlyLocal(iso){
  if (!_isISODateOnly(iso)) return new Date(iso);
  const [y,m,d] = iso.split('-').map(n=>parseInt(n,10));
  // meio-dia local evita problemas de DST/UTC
  return new Date(y, (m||1)-1, d||1, 12, 0, 0, 0);
}
function _dateToISODateOnlyLocal(date){
  const d = (date instanceof Date) ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function formatDateBR(v){
  if (!v) return '';
  const d = _isISODateOnly(v) ? _parseISODateOnlyLocal(v) : new Date(v);
  return d.toLocaleDateString('pt-BR');
}

/* ======= FIREBASE AUTH (LOGIN) ======= */
let auth = null;
try {
  if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) {
    auth = firebase.auth();
  }
} catch(e) {
  console.error('Erro ao inicializar Firebase Auth:', e);
}


// Flag simples para controlar quando o usuário está no fluxo de criação de conta.
let modoCriarConta = false;
let modoEsqueciSenha = false;

function translateFirebaseError(code) {
  switch (code) {
    case 'auth/invalid-email':
      return 'E-mail inválido.';
    case 'auth/user-disabled':
      return 'Usuário desativado.';
    case 'auth/user-not-found':
      return 'Usuário não encontrado.';
    case 'auth/wrong-password':
      return 'Senha incorreta.';
    case 'auth/email-already-in-use':
      return 'Esse e-mail já está em uso.';
    case 'auth/weak-password':
      return 'Senha muito fraca. Use pelo menos 6 caracteres.';
    case 'auth/network-request-failed':
      return 'Falha de rede. Verifique sua conexão com a internet.';
    case 'auth/too-many-requests':
      return 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.';
    case 'auth/unauthorized-domain':
      return 'Domínio não autorizado no Firebase Auth. Adicione o domínio do app na aba Autenticação > Configurações.';
    case 'auth/operation-not-allowed':
      return 'Tipo de login não habilitado no Firebase. Ative "E-mail/senha" em Autenticação > Método de login.';
    default:
      if (!code) return 'Ocorreu um erro ao autenticar. Tente novamente.';
      return 'Ocorreu um erro ao autenticar (' + code + '). Tente novamente ou fale com o suporte.';
  }
}
function setAuthMessage(msg) {
  const box = document.getElementById('authMessage');
  if (!box) return;
  box.textContent = msg || '';
}


function setAuthMode(mode) {
  const titleEl = document.getElementById('authTitle');
  const subEl = document.getElementById('authSubtitle');
  const groupSenha = document.getElementById('groupSenha');
  const groupConf = document.getElementById('groupConfirmSenha');
  const rememberRow = document.getElementById('authRememberRow');
  const googleBtn = document.getElementById('btnGoogleLogin');
  const forgotActions = document.getElementById('forgotActions');
  const btnEntrar = document.getElementById('btnEntrar');
  const btnCadastro = document.getElementById('btnCadastro');
  const btnResetSenha = document.getElementById('btnResetSenha');
  const btnAlterarSenha = document.getElementById('btnAlterarSenha');
  const btnVoltarLogin = document.getElementById('btnVoltarLogin');
  const authBottom = document.getElementById('authBottom');

  modoCriarConta = (mode === 'signup');
  modoEsqueciSenha = (mode === 'forgot');

  if (!titleEl || !subEl) return;

  if (mode === 'signup') {
    titleEl.textContent = 'Criar conta';
    subEl.textContent = 'Informe um e-mail válido, senha e confirmação de senha para criar sua conta de administrador.';

    if (groupConf) groupConf.classList.remove('hidden');
    if (groupSenha) groupSenha.classList.remove('hidden');
    if (rememberRow) rememberRow.classList.add('hidden');
    if (googleBtn) googleBtn.classList.add('hidden');
    if (forgotActions) forgotActions.classList.add('hidden');

    if (btnEntrar) btnEntrar.classList.add('hidden');
    if (btnCadastro) btnCadastro.classList.remove('hidden');
    if (btnResetSenha) btnResetSenha.classList.add('hidden');
    if (btnAlterarSenha) btnAlterarSenha.classList.add('hidden');
    if (btnVoltarLogin) btnVoltarLogin.classList.remove('hidden');

    if (authBottom) {
      authBottom.innerHTML = 'Use um <strong>e-mail válido</strong> e guarde bem sua senha. Esta conta será o administrador do sistema.';
    }

    const emailInput = document.getElementById('emailLogin');
    const senhaInput = document.getElementById('senhaLogin');
    const confInput  = document.getElementById('senhaLoginConf');
    if (emailInput) emailInput.value = '';
    if (senhaInput) senhaInput.value = '';
    if (confInput) confInput.value = '';
    if (emailInput) emailInput.focus();

    setAuthMessage('');
  } else if (mode === 'forgot') {
    titleEl.textContent = 'Recuperar senha';
    subEl.textContent = 'Informe o e-mail para receber o link de redefinição de senha.';

    if (groupSenha) groupSenha.classList.add('hidden');
    if (groupConf) groupConf.classList.add('hidden');
    if (rememberRow) rememberRow.classList.add('hidden');
    if (googleBtn) googleBtn.classList.add('hidden');
    if (forgotActions) forgotActions.classList.remove('hidden');

    if (btnEntrar) btnEntrar.classList.add('hidden');
    if (btnCadastro) btnCadastro.classList.add('hidden');
    if (btnResetSenha) btnResetSenha.classList.add('hidden');
    if (btnAlterarSenha) btnAlterarSenha.classList.add('hidden');
    if (btnVoltarLogin) btnVoltarLogin.classList.remove('hidden');

    if (authBottom) {
      authBottom.textContent = '';
    }

    setAuthMessage('');
  } else {
    titleEl.textContent = 'Entrar';
    subEl.textContent = 'Use seu e-mail e senha cadastrados.';

    if (groupSenha) groupSenha.classList.remove('hidden');
    if (groupConf) groupConf.classList.add('hidden');
    if (rememberRow) rememberRow.classList.remove('hidden');
    if (googleBtn) googleBtn.classList.remove('hidden');
    if (forgotActions) forgotActions.classList.add('hidden');

    if (btnEntrar) btnEntrar.classList.remove('hidden');
    if (btnCadastro) btnCadastro.classList.remove('hidden');
    if (btnResetSenha) btnResetSenha.classList.remove('hidden');
    if (btnAlterarSenha) btnAlterarSenha.classList.remove('hidden');
    if (btnVoltarLogin) btnVoltarLogin.classList.add('hidden');

    if (authBottom) {
      authBottom.innerHTML = 'Ainda não tem cadastro?<span class="auth-bottom-strong"> Crie sua conta com o botão “Criar conta”.</span>';
    }

    setAuthMessage('');
  }
}



function setAlterarSenhaMessage(msg, isError = true) {
  const box = document.getElementById('altSenhaMsg');
  if (!box) return;
  box.textContent = msg || '';
  if (isError) {
    box.style.color = 'var(--danger)';
  } else {
    box.style.color = '#4ade80';
  }
}

function abrirModalAlterarSenha() {
  const modal = document.getElementById('modalAlterarSenha');
  if (!modal) return;

  const emailLogin = document.getElementById('emailLogin');
  const altEmail = document.getElementById('altEmail');
  const altSenhaAtual = document.getElementById('altSenhaAtual');
  const altSenhaNova = document.getElementById('altSenhaNova');
  const altSenhaNova2 = document.getElementById('altSenhaNova2');

  if (altEmail && emailLogin) {
    altEmail.value = emailLogin.value;
  }
  if (altSenhaAtual) altSenhaAtual.value = '';
  if (altSenhaNova) altSenhaNova.value = '';
  if (altSenhaNova2) altSenhaNova2.value = '';
  setAlterarSenhaMessage('');

  modal.classList.remove('hidden');
}

function fecharModalAlterarSenha() {
  const modal = document.getElementById('modalAlterarSenha');
  if (!modal) return;
  modal.classList.add('hidden');
}

async function salvarNovaSenha() {
  if (!auth) {
    setAlterarSenhaMessage('Firebase Auth não está configurado.');
    return;
  }

  const emailEl = document.getElementById('altEmail');
  const atualEl = document.getElementById('altSenhaAtual');
  const novaEl  = document.getElementById('altSenhaNova');
  const nova2El = document.getElementById('altSenhaNova2');

  if (!emailEl || !atualEl || !novaEl || !nova2El) {
    setAlterarSenhaMessage('Campos de alteração de senha não encontrados.');
    return;
  }

  const email = (emailEl.value || '').trim();
  const senhaAtual = atualEl.value || '';
  const senhaNova  = novaEl.value || '';
  const senhaNova2 = nova2El.value || '';

  if (!email || !senhaAtual || !senhaNova || !senhaNova2) {
    setAlterarSenhaMessage('Preencha todos os campos.');
    return;
  }

  if (senhaNova.length < 6) {
    setAlterarSenhaMessage('A nova senha deve ter pelo menos 6 caracteres.');
    return;
  }

  if (senhaNova !== senhaNova2) {
    setAlterarSenhaMessage('A confirmação da nova senha não confere.');
    return;
  }

  if (senhaNova === senhaAtual) {
    setAlterarSenhaMessage('A nova senha deve ser diferente da atual.');
    return;
  }

  setAlterarSenhaMessage('Atualizando senha...', false);

  try {
    const cred = await auth.signInWithEmailAndPassword(email, senhaAtual);
    const user = cred && cred.user ? cred.user : null;
    if (!user) {
      setAlterarSenhaMessage('Não foi possível autenticar o usuário.');
      return;
    }

    await user.updatePassword(senhaNova);

    setAlterarSenhaMessage('Senha alterada com sucesso. Use a nova senha para entrar.', false);
    setTimeout(() => {
      const modal2 = document.getElementById('modalAlterarSenha');
      if(modal2) modal2.classList.add('hidden');
      const loginSenha = document.getElementById('loginSenha');
      if(loginSenha){ loginSenha.focus(); }
    }, 800);
    await auth.signOut();
  } catch (e) {
    console.error(e);
    const code = e && e.code ? e.code : null;
    setAlterarSenhaMessage(translateFirebaseError(code));
  }
}

// Sincroniza os novos campos de horário (dia inteiro / começa / termina)
// com os campos antigos agData/agHora, para manter compatibilidade.
const syncAgFormHiddenFields = () => {
  const diaInteiroEl = $('#agDiaInteiro');
  if (!diaInteiroEl) return;

  const inicioData = $('#agInicioData') ? ($('#agInicioData').value || todayISO()) : ($('#agData')?.value || todayISO());
  const inicioHora = $('#agInicioHora') ? $('#agInicioHora').value || '' : ($('#agHora')?.value || '');
  const fimData    = $('#agFimData')    ? ($('#agFimData').value    || inicioData) : inicioData;
  const fimHora    = $('#agFimHora')    ? $('#agFimHora').value    || '' : '';

  const diaInteiro = diaInteiroEl.checked;

  if ($('#agData')) $('#agData').value = inicioData;
  if ($('#agHora')) $('#agHora').value = diaInteiro ? '' : inicioHora;

  return { diaInteiro, inicioData, inicioHora, fimData, fimHora };
};


/* ======= ESTADO ======= */
let state = {
  perfilId: null,
  perfis: [],
  mostrarInativos: false,
  visaoDono: { funcionarioId: '__all__', mes: '', ranking: true },
  cfg: {estudio:'2letters', moeda:'BRL', tema:'auto', logoBase64:null,
        wpp24:true, wpp2:true, autoBackup:false,
        msgWpp:'Olá! Lembrando do seu horário em {{DATA}} ({{HORA}}).' ,
        msgWppConcluido:'Obrigado por fechar com a gente em {{DATA}} ({{HORA}})! Qualquer dúvida sobre os cuidados é só chamar.',
        msgWppCancelado:'Seu horário de {{SERVICO}} em {{DATA}} ({{HORA}}) foi cancelado. Se quiser remarcar é só responder aqui.',
        pixChave:'',
        cores:{ag:'#3b82f6', co:'#22c55e', ca:'#ef4444'},
        senhaHash:'' },
  data: {clientes:[], servicos:[], agenda:[], tx:[], fiados:[], an:[], usuarios:[], backups:[], lastLogin:''}
}

let agEditId = null;
;


// Helper para saber se o perfil atual é administrador.
// Regras:
// - Se o campo isAdmin existir, usamos ele.
// - Para compatibilidade com versões antigas, se não tiver isAdmin
//   consideramos o primeiro perfil da lista como administrador.

function isPerfilAdmin(pid){
  const perfis = state.perfis || [];
  const perfil = perfis.find(p => p.id === pid);
  if (!perfil) return false;

  if (typeof perfil.isAdmin === 'boolean') return perfil.isAdmin;

  const hasExplicit = perfis.some(p => typeof p.isAdmin === 'boolean');
  if (hasExplicit) return false;

  return perfis.length > 0 && perfis[0].id === perfil.id;
}


// Retorna o objeto do perfil atualmente logado
function getPerfilAtual(){
  return (state.perfis || []).find(p => p.id === state.perfilId) || null;
}

// UID do estabelecimento que é dono dos dados operacionais.
function getDataOwnerId(){
  const perfil = getPerfilAtual();
  if (perfil && perfil.ownerId) return String(perfil.ownerId);
  if (perfil && perfil.isAdmin && perfil.id) return String(perfil.id);
  return '';
}

function getCurrentActorId(){
  return (auth && auth.currentUser && auth.currentUser.uid) ? String(auth.currentUser.uid) : '';
}

function getCurrentActorName(){
  const p = getPerfilAtual();
  return p ? (p.nome || p.email || 'Usuário') : 'Usuário';
}

const DEFAULT_PERMISSIONS = {agenda:true, clientes:true, financeiro:true, anamnese:true};
function getPerfilPermissions(perfil){
  if (!perfil || isPerfilAdmin(perfil.id)) return Object.assign({}, DEFAULT_PERMISSIONS);
  return Object.assign({}, DEFAULT_PERMISSIONS, perfil.permissions || {});
}
function canAccessArea(area){
  const p=getPerfilAtual();
  if(!p) return false;
  if(isPerfilAdmin(p.id)) return true;
  return getPerfilPermissions(p)[area] !== false;
}
function cloudColAllowed(col){
  const p=getPerfilAtual(); if(!p || isPerfilAdmin(p.id)) return true;
  const map={clientes:'clientes',agenda:'agenda',servicos:'agenda',tx:'financeiro',fiados:'financeiro',an:'anamnese'};
  if(col==='audit') return true;
  if(col==='backups' || col==='usuarios') return false;
  return map[col] ? canAccessArea(map[col]) : true;
}
function auditLog(action, entity, entityId, summary, extra={}){
  try{
    if(!state || !state.data) return;
    if(!Array.isArray(state.data.audit)) state.data.audit=[];
    state.data.audit.push(Object.assign({
      id: uid(), action, entity, entityId:String(entityId||''), summary:String(summary||''),
      actorUid:getCurrentActorId(), actorName:getCurrentActorName(), ownerId:getDataOwnerId(),
      at:new Date().toISOString()
    }, extra||{}));
    if(state.data.audit.length>1000) state.data.audit.splice(0,state.data.audit.length-1000);
  }catch(e){ console.error('auditLog',e); }
}

// Retorna true se o perfil do funcionário estiver ativo
function isFuncionarioAtivo(p){
  if (!p) return false;
  if (p.ativo === false) return false;
  if (String(p.situacao || '').toLowerCase() === 'inativo') return false;
  return true;
}


function setMeuUsuarioMessage(msg, isError = true) {
  const box = document.getElementById('meuUsuarioMsg');
  if (!box) return;
  box.textContent = msg || '';
  if (!msg) return;
  box.style.color = isError ? 'var(--danger)' : 'var(--success)';
}


function atualizarAvatarPerfil(perfil){
  const avatarMain = document.querySelector('.perfil-avatar');
  if (avatarMain){
    if (perfil && perfil.avatar){
      avatarMain.innerHTML = `<img src="${perfil.avatar}" alt="Avatar">`;
    } else {
      avatarMain.innerHTML = '<i class="fa-solid fa-user"></i>';
    }
  }
  const avatarSidebar = document.querySelector('.sidebar-avatar');
  if (avatarSidebar){
    if (perfil && perfil.avatar){
      avatarSidebar.innerHTML = `<img src="${perfil.avatar}" alt="Avatar">`;
    } else {
      avatarSidebar.innerHTML = '<i class="fa-regular fa-user"></i>';
    }
  }
}

function renderMeuUsuario() {
  const perfil = getPerfilAtual();
  if (!perfil) return;
  const nomeEl = document.getElementById('meuNome');
  const emailEl = document.getElementById('meuEmail');
  const loginEl = document.getElementById('meuLogin');
  const cpfEl = document.getElementById('meuCpfCnpj');
  const endEl = document.getElementById('meuEndereco');
  const contatoEl = document.getElementById('meuContato');
  const empresaEl = document.getElementById('meuEmpresa');
  const categoriaEl = document.getElementById('meuCategoriaServico');
  const ocultarEmailEl = document.getElementById('meuOcultarEmail');

  if (nomeEl) nomeEl.value = perfil.nome || '';
  if (emailEl) emailEl.value = perfil.email || '';
  if (loginEl) loginEl.value = perfil.email || '';
  if (cpfEl) cpfEl.value = perfil.cpfCnpj || '';
  if (endEl) endEl.value = perfil.endereco || '';
  if (contatoEl) contatoEl.value = perfil.contato || '';
  if (empresaEl) empresaEl.value = perfil.empresa || '';
  if (categoriaEl) categoriaEl.value = perfil.categoriaServico || '';
  if (ocultarEmailEl) ocultarEmailEl.checked = !!perfil.ocultarEmail;

  atualizarAvatarPerfil(perfil);
  renderSidebarPerfil();
}

function renderSidebarPerfil(){
  const perfil = getPerfilAtual();
  atualizarAvatarPerfil(perfil);
  const nome = perfil && perfil.nome ? perfil.nome : '—';
  const ocultarEmail = perfil && perfil.ocultarEmail;
  const email = (!ocultarEmail && perfil && perfil.email) ? perfil.email : '';
  const categoria = perfil && perfil.categoriaServico ? perfil.categoriaServico : '';
  const roleFallback = isPerfilAdmin(state.perfilId) ? 'Administrador' : 'Funcionário';
  const role = categoria || roleFallback;

  const nomeEl = document.getElementById('sbNome');
  const emailEl = document.getElementById('sbEmail');
  const studioEl = document.getElementById('sbStudio');
  const roleEl = document.getElementById('sbRole');
  const endEl = document.getElementById('sbEndereco');
  const contatoEl = document.getElementById('sbContato');
  const empresaEl = document.getElementById('sbEmpresa');

  const empresa = (perfil && perfil.empresa) ? perfil.empresa : '';
  const endereco = (perfil && perfil.endereco) ? perfil.endereco : '';
  const contato = (perfil && perfil.contato) ? perfil.contato : '';

  if (nomeEl) nomeEl.textContent = nome;

  // E-mail, função, endereço e contato só aparecem se tiverem valor preenchido
  const updateInfoRow = (spanEl, value) => {
    if (!spanEl || !spanEl.parentElement) return;
    spanEl.textContent = value || '';
    const row = spanEl.parentElement;
    row.style.display = value ? '' : 'none';
  };

  updateInfoRow(emailEl, email);
  updateInfoRow(roleEl, role);
  updateInfoRow(endEl, endereco);
  updateInfoRow(contatoEl, contato);

  // Mostra o nome da empresa apenas uma vez (na linha onde antes era "Studio LH")
  if (studioEl) {
    studioEl.textContent = empresa || '';
    studioEl.style.display = empresa ? 'block' : 'none';
  }

  // Linha extra de empresa não é mais necessária; mantém vazia/oculta
  if (empresaEl) {
    empresaEl.textContent = '';
    empresaEl.style.display = 'none';
  }
}


async function salvarMeuUsuario() {
  const perfil = getPerfilAtual();
  if (!perfil) {
    setMeuUsuarioMessage('Nenhum perfil carregado.');
    return;
  }

  const nomeEl = document.getElementById('meuNome');
  const emailEl = document.getElementById('meuEmail');
  const loginEl = document.getElementById('meuLogin');
  const cpfEl = document.getElementById('meuCpfCnpj');
  const endEl = document.getElementById('meuEndereco');
  const contatoEl = document.getElementById('meuContato');
  const empresaEl = document.getElementById('meuEmpresa');
  const categoriaEl = document.getElementById('meuCategoriaServico');
  const ocultarEmailEl = document.getElementById('meuOcultarEmail');
  const novaSenhaEl = document.getElementById('meuNovaSenha');
  const novaSenha2El = document.getElementById('meuNovaSenha2');

  const nome = nomeEl ? nomeEl.value.trim() : '';
  const email = emailEl ? emailEl.value.trim() : '';
  const cpf = cpfEl ? cpfEl.value.trim() : '';
  const endereco = endEl ? endEl.value.trim() : '';
  const contato = contatoEl ? contatoEl.value.trim() : '';
  const empresa = empresaEl ? empresaEl.value.trim() : '';
  const categoriaServico = categoriaEl ? categoriaEl.value.trim() : '';
  const ocultarEmail = ocultarEmailEl ? !!ocultarEmailEl.checked : false;
  const novaSenha = novaSenhaEl ? novaSenhaEl.value : '';
  const novaSenha2 = novaSenha2El ? novaSenha2El.value : '';

  if (!nome || !email) {
    setMeuUsuarioMessage('Nome e e-mail são obrigatórios.');
    return;
  }

  if (novaSenha || novaSenha2) {
    if (novaSenha.length < 6) {
      setMeuUsuarioMessage('A nova senha deve ter pelo menos 6 caracteres.');
      return;
    }
    if (novaSenha !== novaSenha2) {
      setMeuUsuarioMessage('A confirmação da nova senha não confere.');
      return;
    }
  }

  // Atualiza dados locais do perfil
  perfil.nome = nome;
  perfil.email = email;
  perfil.cpfCnpj = cpf;
  perfil.endereco = endereco;
  perfil.contato = contato;
  perfil.empresa = empresa;
  perfil.categoriaServico = categoriaServico;
  perfil.ocultarEmail = ocultarEmail;
  // login sempre segue o e-mail
  if (loginEl) loginEl.value = email;

  savePerfis();
  renderPerfis && renderPerfis();

  // Atualiza senha no Firebase, se solicitado
  if (novaSenha && auth && auth.currentUser) {
    try {
      await auth.currentUser.updatePassword(novaSenha);
    } catch (e) {
      console.error('Erro ao atualizar senha do usuário logado', e);
      setMeuUsuarioMessage(translateFirebaseError(e.code) || 'Erro ao atualizar a senha.', true);
      return;
    }
  }

  setMeuUsuarioMessage('Dados atualizados com sucesso.', false);

  if (novaSenhaEl) novaSenhaEl.value = '';
  if (novaSenha2El) novaSenha2El.value = '';

  renderSidebarPerfil();
}



// Aplica permissões de acordo com o perfil atual (admin x funcionário)
function aplicarPermissoesPerfil(){
  const perfil = getPerfilAtual();
  const isAdmin = perfil && isPerfilAdmin(perfil.id);

  // Aba / menu de Funcionários (Usuários)
  const usuariosTab = document.querySelector('#tab-usuarios');
  const usuariosMenuItem = document.querySelector('#navMenu .menu-item[data-tab="usuarios"]');

  // Aba / menu Visão do Dono
  const visaoDonoTab = document.querySelector('#tab-visao-dono');
  const visaoDonoMenuItem = document.querySelector('#navMenu .menu-item[data-tab="visao-dono"]');

  // Aba / menu Admin (backup / banco de dados)
  const adminTab = document.querySelector('#tab-admin');
  const adminMenuItem = document.querySelector('#navMenu .menu-item[data-tab="admin"]');

  // Aba / menu Config (configurações globais)
  const configTab = document.querySelector('#tab-config');
  const configMenuItem = document.querySelector('#navMenu .menu-item[data-tab="config"]');

  if (isAdmin){
    if (usuariosTab) usuariosTab.classList.remove('hidden');
    if (usuariosMenuItem) usuariosMenuItem.classList.remove('hidden');

    if (visaoDonoTab) visaoDonoTab.classList.remove('hidden');
    if (visaoDonoMenuItem) visaoDonoMenuItem.classList.remove('hidden');

    if (adminTab) adminTab.classList.remove('hidden');
    if (adminMenuItem) adminMenuItem.classList.remove('hidden');

    if (configTab) configTab.classList.remove('hidden');
    if (configMenuItem) configMenuItem.classList.remove('hidden');
  } else {
    if (usuariosTab) usuariosTab.classList.add('hidden');
    if (usuariosMenuItem) usuariosMenuItem.classList.add('hidden');

    if (visaoDonoTab) visaoDonoTab.classList.add('hidden');
    if (visaoDonoMenuItem) visaoDonoMenuItem.classList.add('hidden');

    if (adminTab) adminTab.classList.add('hidden');
    if (adminMenuItem) adminMenuItem.classList.add('hidden');

    if (configTab) configTab.classList.add('hidden');
    if (configMenuItem) configMenuItem.classList.add('hidden');
  }

  const areaTabs = {agenda:'agenda', servicos:'agenda', clientes:'clientes', financeiro:'financeiro', anamnese:'anamnese'};
  Object.entries(areaTabs).forEach(([tab,area])=>{
    const pane=document.querySelector('#tab-'+tab);
    const menu=document.querySelector('#navMenu .menu-item[data-tab="'+tab+'"]');
    const ok=isAdmin || canAccessArea(area);
    if(pane) pane.classList.toggle('hidden', !ok);
    if(menu) menu.classList.toggle('hidden', !ok);
  });
}
// A lista de perfis/funcionários agora é **cloud-first**.
// Mantemos a chave apenas como cache opcional (não é mais fonte de verdade).
const LS_KEY = 'studioLH__perfis';             // cache opcional (legado)
const NS = (pid) => `studioLH__${pid}__data`;  // namespace por perfil
const CFG = (pid) => `studioLH__${pid}__cfg`;


// Coleção no Firestore para armazenar todos os perfis/funcionários de forma centralizada
const PERFIS_COLLECTION = 'perfis_usuarios';

/**
 * Sincroniza a lista local de perfis com o Firestore (envia tudo que está no state.perfis).
 * Mantém a lista centralizada para que outros dispositivos possam enxergar os mesmos funcionários.
 */
async function syncPerfisToFirestore(){
  try{
    if (!window.db || !Array.isArray(state.perfis)) return;
    const perfis = state.perfis || [];
    if (!perfis.length) return;

    const batch = db.batch();
    perfis.forEach(p=>{
      if (!p || !p.id) return;
      const data = Object.assign({}, p);
      if (data.email) data.emailLower = String(data.email).toLowerCase();
      const ref = db.collection(PERFIS_COLLECTION).doc(String(p.id));
      batch.set(ref, data, { merge:true });
    });
    await batch.commit();
  }catch(e){
    console.error('Erro ao sincronizar perfis para Firestore', e);
  }
}

/**
 * Carrega perfis do Firestore e mescla com o que estiver salvo localmente.
 * Se não houver nada remoto mas existir algo local, envia os dados locais para o Firestore.
 */
// Carrega perfis do Firestore.
// - Se passar { ownerId }, lista todos os perfis/funcionários daquele administrador.
// - Se passar { email }, busca um perfil específico (útil para descobrir o papel do usuário logado).
async function syncPerfisFromFirestore(opts){
  try{
    if (!window.db) return;

    const o = opts || {};
    let query = db.collection(PERFIS_COLLECTION);
    if (o.ownerId) {
      query = query.where('ownerId', '==', String(o.ownerId));
    }
    if (o.email) {
      query = query.where('emailLower','==', String(o.email).toLowerCase());
    }

    const snap = await query.get();
    const remotos = [];
    snap.forEach(doc=>{
      const d = doc.data() || {};
      if (!d.id) d.id = doc.id;
      remotos.push(d);
    });

    if (remotos.length){
      const mapa = new Map();
      (state.perfis || []).forEach(p=>{
        if (p && p.id) mapa.set(String(p.id), p);
      });
      remotos.forEach(p=>{
        if (!p || !p.id) return;
        const idStr = String(p.id);
        const atual = mapa.get(idStr) || {};
        mapa.set(idStr, Object.assign({}, atual, p));
      });
      state.perfis = Array.from(mapa.values());
      if (typeof renderPerfis === 'function') renderPerfis();
    }
  }catch(e){
    console.error('Erro ao carregar perfis do Firestore', e);
  }
}




/* ======= LISTENER REALTIME (FUNCIONÁRIOS) ======= */
// Mantém a lista de funcionários sempre sincronizada com o Firestore, evitando "sumir" ao atualizar.
let _perfisUnsub = null;

function stopPerfisListener(){
  try { if (typeof _perfisUnsub === 'function') _perfisUnsub(); } catch(_) {}
  _perfisUnsub = null;
}

function startPerfisListener(ownerId){
  try{
    if (!window.db || !ownerId) return;
    stopPerfisListener();

    _perfisUnsub = db.collection(PERFIS_COLLECTION)
      .where('ownerId','==', String(ownerId))
      .onSnapshot((snap)=>{
        const remotos = [];
        snap.forEach(doc=>{
          const d = doc.data() || {};
          if (!d.id) d.id = doc.id;
          remotos.push(d);
        });

        // (Opcional) garante o próprio admin no array
        const uidStr = (auth && auth.currentUser && auth.currentUser.uid) ? String(auth.currentUser.uid) : '';
        if (uidStr && !remotos.some(p => String(p.id) === uidStr)){
          const adminLocal = (state.perfis || []).find(p => String(p.id) === uidStr);
          if (adminLocal) remotos.push(adminLocal);
        }

        state.perfis = remotos;
        try { if (typeof renderPerfis === 'function') renderPerfis(); } catch(_) {}
        try { if (typeof renderFuncionarios === 'function') renderFuncionarios(); } catch(_) {}
        try { if (typeof renderUsuarios === 'function') renderUsuarios(); } catch(_) {}
      }, (err)=>{
        console.error('Erro no listener de perfis_usuarios', err);
      });
  }catch(e){
    console.error('Erro ao iniciar listener de perfis_usuarios', e);
  }
}

/* ======= STORAGE ======= */
function loadPerfis(){
  // Cloud-first: não carregamos mais a lista de funcionários do localStorage.
  // Mantemos apenas um cache opcional, mas a fonte de verdade é o Firestore.
  state.perfis = [];
  try { renderPerfis(); } catch(_) {}

  // Se já houver usuário autenticado, carregamos a base do Firestore.
  try {
    if (auth && auth.currentUser && auth.currentUser.uid) {
      // mantém a lista atualizada em tempo real
      startPerfisListener(String(auth.currentUser.uid));
    }
  } catch(e) { console.error(e); }

  // Trata retorno do login com Google via redirect
  try {
    if (auth && typeof auth.getRedirectResult === 'function') {
      auth.getRedirectResult().then(function(cred){
        if (cred && cred.user && cred.user.email) {
          const emailLower = cred.user.email.toLowerCase();
          integrarUsuarioAoSistema(emailLower);
        }
      }).catch(function(e){
        console.error(e);
      });
    }
  } catch(e) {
    console.error(e);
  }


}
function savePerfis(){
  // Cloud-only: a lista de funcionários deve ficar centralizada na nuvem.
  try { syncPerfisToFirestore(); } catch(e){ console.error(e); }
}

function ensurePerfilData(pid){
  // Cloud-only: não cria nada em localStorage.
  // Mantido apenas para compatibilidade com chamadas antigas.
  return;
}
async function loadPerfil(pid){
  // Cloud-only: pid é ignorado; usamos o usuário logado (uid).
  try{
    if(!auth || !auth.currentUser){
      throw new Error('Usuário não autenticado.');
    }
    const uidStr = String(auth.currentUser.uid);
    state.perfilId = uidStr;

    // ===== PERFIL (ROLE) =====
    // Agora o papel (admin x funcionário) vem do Firestore.
    // Regras:
    // 1) Se existir doc perfis_usuarios/{uid} -> usamos ele.
    // 2) Se não existir, tentamos localizar por e-mail (emailLower) para evitar duplicidade.
    // 3) Se ainda não existir (primeiro acesso), criamos o perfil como ADMIN (dono da conta).
    const currentEmail = (auth.currentUser.email || '').toLowerCase();
    let meuPerfil = null;
    try {
      if (window.db) {
        const refUid = db.collection(PERFIS_COLLECTION).doc(uidStr);
        const docUid = await refUid.get();
        if (docUid && docUid.exists) {
          meuPerfil = Object.assign({}, docUid.data() || {}, { id: uidStr });
        } else if (currentEmail) {
          const snapEmail = await db.collection(PERFIS_COLLECTION)
            .where('emailLower', '==', currentEmail)
            .limit(1)
            .get();
          if (!snapEmail.empty) {
            const d = snapEmail.docs[0].data() || {};
            // normaliza para doc do uid atual
            meuPerfil = Object.assign({}, d, { id: uidStr });
            await refUid.set(meuPerfil, { merge: true });
          }
        }

        if (!meuPerfil) {
          // Segurança: login existente sem perfil NÃO recebe privilégio administrativo.
          try { await auth.signOut(); } catch(_) {}
          document.body.classList.add('only-login');
          if ($('#loginCard')) $('#loginCard').classList.remove('hidden');
          if ($('#sidebar')) $('#sidebar').classList.add('hidden');
          setAuthMessage('Seu usuário não possui acesso ativo a este estabelecimento. Entre em contato com o administrador.');
          return;
        }
      }
    } catch(e) {
      console.error('Erro ao resolver perfil do usuário', e);
    }

    
// Bloqueio por inativação (modo recomendado: Firestore).
// Se o perfil estiver inativo, derruba o login imediatamente e impede acesso ao app.
if (meuPerfil && (meuPerfil.ativo === false || String(meuPerfil.situacao || '').toLowerCase() === 'inativo')) {
  try { await auth.signOut(); } catch(_) {}
  document.body.classList.add('only-login');
  if ($('#loginCard')) $('#loginCard').classList.remove('hidden');
  if ($('#sidebar')) $('#sidebar').classList.add('hidden');
  setAuthMessage('Seu acesso está INATIVO. Fale com o administrador para reativar.');
  return;
}

// Carrega a lista de perfis visíveis para este login:
    // - Admin: todos os perfis do ownerId (inclui o próprio)
    // - Funcionário: apenas o próprio perfil
    state.perfis = [];
    if (meuPerfil) {
      if (meuPerfil.isAdmin) {
        // inicia listener realtime para a lista de funcionários
        startPerfisListener(meuPerfil.ownerId || uidStr);
        await syncPerfisFromFirestore({ ownerId: meuPerfil.ownerId || uidStr });
        // garante que o próprio admin está na lista
        if (!(state.perfis || []).some(p => String(p.id) === uidStr)) {
          state.perfis = (state.perfis || []).concat([meuPerfil]);
        }
      } else {
        // Funcionário também recebe a lista do próprio estabelecimento para
        // seleção de responsável, sem ganhar poderes administrativos.
        await syncPerfisFromFirestore({ ownerId: meuPerfil.ownerId });
        if (!(state.perfis||[]).some(p=>String(p.id)===uidStr)) state.perfis=(state.perfis||[]).concat([meuPerfil]);
      }
    }

    // carrega do Firestore (cfg + subcoleções)
    const dataOwnerId = String((meuPerfil && meuPerfil.ownerId) || (meuPerfil && meuPerfil.isAdmin ? uidStr : ''));
    if (!dataOwnerId) throw new Error('Perfil sem ownerId válido.');
    const loaded = await loadCloudState(dataOwnerId);
    state.cfg = Object.assign({}, state.cfg, loaded.cfg || {});
    state.data = loaded.data || {clientes:[],servicos:[],agenda:[],tx:[],fiados:[],an:[],usuarios:[],backups:[], lastLogin:''};

    // Migração/garantia de campos
    if (!Array.isArray(state.data.fiados)) state.data.fiados = [];

    // garante autosave reativo
    attachCloudAutosave();

    applyTheme(state.cfg.tema);

    // aplicar UI config
    if ($('#cfgEstudio')) $('#cfgEstudio').value = state.cfg.estudio||'';
    if ($('#cfgMoeda'))   $('#cfgMoeda').value   = state.cfg.moeda||'BRL';
    if ($('#cfgTema'))    $('#cfgTema').value    = state.cfg.tema||'auto';
    if ($('#cfgWpp24'))   $('#cfgWpp24').checked = !!state.cfg.wpp24;
    if ($('#cfgWpp2'))    $('#cfgWpp2').checked  = !!state.cfg.wpp2;
    if ($('#cfgAutoBackup')) $('#cfgAutoBackup').checked = !!state.cfg.autoBackup;
    if ($('#cfgMsgWpp'))  $('#cfgMsgWpp').value = state.cfg.msgWpp||'';
    if ($('#cfgMsgWppConcluido')) $('#cfgMsgWppConcluido').value = state.cfg.msgWppConcluido||'';
    if ($('#cfgMsgWppCancelado')) $('#cfgMsgWppCancelado').value = state.cfg.msgWppCancelado||'';
    if ($('#cfgPixChave')) $('#cfgPixChave').value = state.cfg.pixChave||'';

    if ($('#corAg') && state.cfg.cores) $('#corAg').value = state.cfg.cores.ag;
    if ($('#corCo') && state.cfg.cores) $('#corCo').value = state.cfg.cores.co;
    if ($('#corCa') && state.cfg.cores) $('#corCa').value = state.cfg.cores.ca;
    if (state.cfg.cores){
      document.documentElement.style.setProperty('--cor-ag', state.cfg.cores.ag);
      document.documentElement.style.setProperty('--cor-co', state.cfg.cores.co);
      document.documentElement.style.setProperty('--cor-ca', state.cfg.cores.ca);
    }

    document.body.classList.remove('only-login');
    const userBoxEl = $('#userBox');
    if (userBoxEl) userBoxEl.classList.remove('hidden');

    const userRoleEl = $('#userRole');
    if (userRoleEl) {
      const pa = getPerfilAtual();
      userRoleEl.textContent = (pa && pa.isAdmin) ? 'Administrador' : 'Funcionário';
    }

    renderMeuUsuario();
    renderSidebarPerfil();

    if ($('#loginCard')) $('#loginCard').classList.add('hidden');
    if ($('#sidebar')) $('#sidebar').classList.remove('hidden');

    if ($('#tab-agenda')) $('#tab-agenda').classList.add('show');

    // permissões: como cada login é dono de si, podemos manter abas liberadas
    try { aplicarPermissoesPerfil(); } catch(e){}

    state.data.lastLogin = new Date().toISOString();
    scheduleCloudSync(50);

    refreshAll();
    refreshSystemStats();
    refreshDbStatus();
  }catch(e){
    console.error(e);
    setAuthMessage('Erro ao carregar seus dados na nuvem. Verifique conexão e regras do Firestore.');
  }
}
function savePerfil(){
  // Cloud-only: agenda persistência na nuvem
  scheduleCloudSync();
}

/* ======= HASH (simples) ======= */
const simpleHash = (s)=> btoa(unescape(encodeURIComponent(s))).split('').reverse().join('');

/* ======= Layout: altura do cabeçalho fixo ======= */
function syncAppHeaderHeight(){
  try{
    const header = document.querySelector('.app-header');
    if (!header) return;
    const h = header.offsetHeight || 0;
    if (h > 0) document.documentElement.style.setProperty('--app-header-h', h + 'px');
  }catch(e){ /* noop */ }
}

/* ======= INICIAL ======= */
document.addEventListener('DOMContentLoaded', init);
function init(){
  setTimeout(()=>{ const q=$('#buscaAuditV4'); if(q) q.oninput=renderAuditV4; },0);
  // garante que modais (ex.: Novo Agendamento) abram abaixo do cabeçalho fixo
  syncAppHeaderHeight();
  window.addEventListener('resize', syncAppHeaderHeight);
  window.addEventListener('orientationchange', syncAppHeaderHeight);

  // Cloud-first: tema inicial neutro (será ajustado depois de carregar cfg da nuvem).
  applyTheme('auto');

  // Cloud-only: não usamos perfis locais.
  try { state.perfis = []; } catch(e){}

  // Se já estiver logado (refresh / outro dispositivo), carrega direto.
  try{
    if (auth && typeof auth.onAuthStateChanged === 'function') {
      auth.onAuthStateChanged(function(user){
        if (user && user.email) {
          integrarUsuarioAoSistema(user.email);
        }
      });
    }
  }catch(e){ console.error(e); }
  // Trata retorno do login com Google via redirect
  try {
    if (auth && typeof auth.getRedirectResult === 'function') {
      auth.getRedirectResult().then(function(cred){
        if (cred && cred.user && cred.user.email) {
          const emailLower = cred.user.email.toLowerCase();
          integrarUsuarioAoSistema(emailLower);
        }
      }).catch(function(e){
        console.error(e);
      });
    }
  } catch(e) {
    console.error(e);
  }


  // Modo de autenticação inicial
  try {
    setAuthMode('login');
  } catch(e) { /* pode não estar na tela de login */ }

  // Preenche e-mail salvo (lembrar de mim)
  try {
    const savedEmail = localStorage.getItem('studioLH__remember_email');
    if (savedEmail) {
      const emailInput = document.getElementById('emailLogin');
      const rememberEl = document.getElementById('rememberLogin');
      if (emailInput) emailInput.value = savedEmail;
      if (rememberEl) rememberEl.checked = true;
    }
  } catch(e) {}



  
  // Controle da tela "Usuários": alternar entre lista e formulário de cadastro
  try {
    const listView = $('#usuariosListView');
    const cadView = $('#usuariosCadastroView');

    if (listView && cadView) {
      // Estado inicial: mostra lista, esconde cadastro
      listView.classList.remove('hidden');
      cadView.classList.add('hidden');
    }

    const btnNovo = $('#btnNovoFuncionario');
    if (btnNovo && listView && cadView) {
      btnNovo.onclick = function(){
        listView.classList.add('hidden');
        cadView.classList.remove('hidden');
      };

    // Botão: mostrar/ocultar funcionários inativos (apenas visual)
    const btnToggleInativos = $('#btnToggleInativos');
    if (btnToggleInativos) {
      btnToggleInativos.textContent = state.mostrarInativos ? 'Ocultar inativos' : 'Mostrar inativos';
      btnToggleInativos.onclick = function(){
        state.mostrarInativos = !state.mostrarInativos;
        btnToggleInativos.textContent = state.mostrarInativos ? 'Ocultar inativos' : 'Mostrar inativos';
        renderFuncionarios();
      };
    }
    }

    const btnSalvar = $('#usAdd');
    if (btnSalvar) {
      btnSalvar.onclick = addFuncionarioUsuarios;
    }

    const btnCancelar = $('#btnCancelarCadastroFuncionario');
    if (btnCancelar && listView && cadView) {
      btnCancelar.onclick = function(){
        cadView.classList.add('hidden');
        listView.classList.remove('hidden');
      };
    }
  } catch(e){
    console.error(e);
  }



  const hoje = new Date();

  if ($('#agInicioData')) $('#agInicioData').valueAsDate = hoje;
  if ($('#agFimData'))    $('#agFimData').valueAsDate    = hoje;
  if ($('#agData'))       $('#agData').valueAsDate       = hoje;
  if ($('#txData'))       $('#txData').valueAsDate       = hoje;

  const syncDataInputs = () => {
    syncAgFormHiddenFields();
    renderMainCalendar();
  };

let agendaFilter = 'all'; // filtro rápido da agenda (today/tomorrow/week/all)


  if ($('#agInicioData')) $('#agInicioData').addEventListener('change', syncDataInputs);
  if ($('#agFimData'))    $('#agFimData').addEventListener('change', renderMainCalendar);

  if ($('#agDiaInteiro')) {
    const toggleDiaInteiro = () => {
      const full = $('#agDiaInteiro').checked;
      if ($('#agInicioHora')) $('#agInicioHora').disabled = full;
      if ($('#agFimHora'))    $('#agFimHora').disabled    = full;
      if (full) {
        if ($('#agInicioHora')) $('#agInicioHora').value = '';
        if ($('#agFimHora'))    $('#agFimHora').value    = '';
      }
      syncAgFormHiddenFields();
      renderMainCalendar();
    };
    $('#agDiaInteiro').addEventListener('change', toggleDiaInteiro);
    toggleDiaInteiro();
  }

  
  // eventos principais
  if ($('#btnEntrar')) $('#btnEntrar').onclick = entrarSistema;
  if ($('#btnCadastro')) $('#btnCadastro').onclick = onClickCriarConta;
  if ($('#btnResetSenha')) $('#btnResetSenha').onclick = onClickEsqueciSenha;
  if ($('#btnAlterarSenha')) $('#btnAlterarSenha').onclick = abrirModalAlterarSenha;
  if ($('#btnGoogleLogin')) $('#btnGoogleLogin').onclick = entrarComGoogle;
  if ($('#btnVoltarLogin')) $('#btnVoltarLogin').onclick = function(){ setAuthMode('login'); };
  if ($('#btnEnviarReset')) $('#btnEnviarReset').onclick = resetSenhaFirebase;
  if ($('#btnSair')) $('#btnSair').onclick = sairSistema;
  if ($('#sbBtnSair')) $('#sbBtnSair').onclick = sairSistema;

  const notificationsScreen = document.getElementById('notificationsScreen');
const btnToggleSaldo = document.getElementById('btnToggleSaldo');
const btnCloseNotifications = document.getElementById('btnCloseNotifications');

function openNotificationsScreen(){
  try{ requestNotificationPermission(); }catch(e){}
  if(!notificationsScreen) return;
  notificationsScreen.classList.remove('hidden');
  document.body.classList.add('notif-open');
  renderNotifications();
}

function closeNotificationsScreen(){
  if(!notificationsScreen) return;
  notificationsScreen.classList.add('hidden');
  document.body.classList.remove('notif-open');
}

if (btnToggleSaldo) btnToggleSaldo.addEventListener('click', openNotificationsScreen);
if (btnCloseNotifications) btnCloseNotifications.addEventListener('click', closeNotificationsScreen);

// Fecha no ESC (desktop)
document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape' && notificationsScreen && !notificationsScreen.classList.contains('hidden')){
    closeNotificationsScreen();
  }
});
if ($('#altSenhaCancelar')) $('#altSenhaCancelar').onclick = fecharModalAlterarSenha;
  if ($('#altSenhaFechar')) $('#altSenhaFechar').onclick = fecharModalAlterarSenha;
  if ($('#altSenhaSalvar')) $('#altSenhaSalvar').onclick = salvarNovaSenha;

  if ($('#btnMeuUsuarioSalvar')) $('#btnMeuUsuarioSalvar').onclick = salvarMeuUsuario;

  const imgBtn = $('#btnMeuUsuarioImagem');
  const imgInput = $('#meuUsuarioImagemInput');
  if (imgBtn && imgInput){
    imgBtn.onclick = ()=> imgInput.click();
    imgInput.addEventListener('change', handleMeuUsuarioImagemChange);
  }

  // $('#btnAddFuncionario').onclick = addFuncionario; // Removido a pedido do usuário
  // binding do botão de salvar funcionário é configurado de acordo com o modo (lista vs cadastro)

  $('#btnAgendar').onclick = salvarAgendamento;
  // Campo de imagem do agendamento removido

  $('#openReceita').onclick = ()=>openFormTx('receita');
  $('#openDespesa').onclick = ()=>openFormTx('despesa');
  $('#btnCloseTx').onclick = ()=>$('#formTransacao').classList.add('hidden');
  $('#btnAddTx').onclick = addTransacao;

  // Fiados
  if ($('#btnNovoFiado')) $('#btnNovoFiado').onclick = ()=>openFormFiado();
  if ($('#btnCancelarFiado')) $('#btnCancelarFiado').onclick = closeFormFiado;
  if ($('#btnSalvarFiado')) $('#btnSalvarFiado').onclick = salvarFiado;
  if ($('#buscaFiado')) $('#buscaFiado').oninput = renderFiados;

  $('#btnAddCliente').onclick = addCliente;

  const btnNovoCliente = $('#btnNovoCliente');
  if (btnNovoCliente) {
    btnNovoCliente.onclick = ()=>{
      // Abre a tela dedicada de cadastro de cliente
      $('#clNome').value=''; $('#clEmail').value=''; $('#clZap').value=''; $('#clNasc').value=''; $('#clEnd').value='';
      $('#btnAddCliente').textContent='Cadastrar Cliente';
      $('#btnAddCliente').onclick = addCliente;
      if (typeof abrirCadastroCliente === 'function') abrirCadastroCliente();
      $('#clNome').focus();
    };
  }

  // Aniversariantes (hoje)
  const btnAnivers = document.getElementById('btnAniversariantes');
  if (btnAnivers) btnAnivers.onclick = openModalAniversariantes;
  const anivFechar = document.getElementById('anivFechar');
  if (anivFechar) anivFechar.onclick = closeModalAniversariantes;
  const modalAniv = document.getElementById('modalAniversariantes');
  if (modalAniv){
    const backdrop = modalAniv.querySelector('.auth-modal-backdrop[data-close="1"]');
    if (backdrop) backdrop.onclick = closeModalAniversariantes;
  }

  const btnVoltarClientes = $('#btnVoltarClientes');
  if (btnVoltarClientes) {
    btnVoltarClientes.onclick = ()=>{
      // Volta para a lista de clientes e reseta o formulário
      $('#clNome').value=''; $('#clEmail').value=''; $('#clZap').value=''; $('#clNasc').value=''; $('#clEnd').value='';
      $('#btnAddCliente').textContent='Cadastrar Cliente';
      $('#btnAddCliente').onclick = addCliente;
      if (typeof voltarListaClientes === 'function') voltarListaClientes();
    };
  }

  $('#btnAddServico').onclick = addServico;

  const btnNovoServico = $('#btnNovoServico');
  if (btnNovoServico) {
    btnNovoServico.onclick = ()=>{
      $('#svNome').value=''; $('#svDescricao').value=''; $('#svPreco').value='0,00'; $('#svDuracao').value='';
      $('#btnAddServico').textContent='Cadastrar Serviço';
      $('#btnAddServico').onclick = addServico;
      if (typeof abrirCadastroServico === 'function') abrirCadastroServico();
      $('#svNome').focus();
    };
  }

  const btnVoltarServicos = $('#btnVoltarServicos');
  if (btnVoltarServicos) {
    btnVoltarServicos.onclick = ()=>{
      $('#svNome').value=''; $('#svDescricao').value=''; $('#svPreco').value='0,00'; $('#svDuracao').value='';
      $('#btnAddServico').textContent='Cadastrar Serviço';
      $('#btnAddServico').onclick = addServico;
      if (typeof voltarListaServicos === 'function') voltarListaServicos();
    };
  }

  $('#agServicoSel').addEventListener('change', preencherValorServico);

  // Seletor com aparência de botão (Agenda)
  const btnAgClientePicker = document.getElementById('btnAgClientePicker');
  if (btnAgClientePicker) {
    btnAgClientePicker.onclick = openModalBuscaClienteAg;
  }
  const selAgCliente = document.getElementById('agCliente');
  if (selAgCliente) {
    selAgCliente.addEventListener('change', ()=>{ try { syncAgClientePicker(); } catch(e) {} });
    try { syncAgClientePicker(); } catch(e) {}
  }

  const btnAgServicoSelPicker = document.getElementById('btnAgServicoSelPicker');
  if (btnAgServicoSelPicker) {
    // Abre o modal de busca/seleção de serviços (Novo Agendamento)
    btnAgServicoSelPicker.onclick = openModalBuscaServicoAg;
  }
  const selAgServicoSel = document.getElementById('agServicoSel');
  if (selAgServicoSel) {
    selAgServicoSel.addEventListener('change', ()=>{ try { syncAgServicoSelPicker(); } catch(e) {} });
    try { syncAgServicoSelPicker(); } catch(e) {}
  }

  // Lupa de busca de cliente no Novo Agendamento
  const btnBuscaClienteAg = document.getElementById('btnBuscaClienteAg');
  if (btnBuscaClienteAg) {
    btnBuscaClienteAg.onclick = openModalBuscaClienteAg;
  }
  const modalBuscaClienteAg = document.getElementById('modalBuscaClienteAg');
  if (modalBuscaClienteAg) {
    const fechar = document.getElementById('agClienteBuscaFechar');
    if (fechar) fechar.onclick = closeModalBuscaClienteAg;
    const backdrop = modalBuscaClienteAg.querySelector('.auth-modal-backdrop[data-close="1"]');
    if (backdrop) backdrop.onclick = closeModalBuscaClienteAg;
    const inp = document.getElementById('agClienteBuscaInput');
    if (inp) {
      inp.addEventListener('input', ()=>renderBuscaClienteAgLista(inp.value));
      inp.addEventListener('keydown', (e)=>{ if(e.key==='Enter') e.preventDefault(); });
    }
    document.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape' && !modalBuscaClienteAg.classList.contains('hidden')) {
        closeModalBuscaClienteAg();
      }
    });
  }

  // Modal de busca de serviço no Novo Agendamento
  const modalBuscaServicoAg = document.getElementById('modalBuscaServicoAg');
  if (modalBuscaServicoAg) {
    const fechar = document.getElementById('agServicoBuscaFechar');
    if (fechar) fechar.onclick = closeModalBuscaServicoAg;
    const backdrop = modalBuscaServicoAg.querySelector('.auth-modal-backdrop[data-close="1"]');
    if (backdrop) backdrop.onclick = closeModalBuscaServicoAg;
    const inp = document.getElementById('agServicoBuscaInput');
    if (inp) {
      inp.addEventListener('input', ()=>renderBuscaServicoAgLista(inp.value));
      inp.addEventListener('keydown', (e)=>{ if(e.key==='Enter') e.preventDefault(); });
    }
    document.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape' && !modalBuscaServicoAg.classList.contains('hidden')) {
        closeModalBuscaServicoAg();
      }
    });
  }

  // ===== Modal: Novo Agendamento (form dentro da modal) =====
  const modalNovoAgendamento = document.getElementById('modalNovoAgendamento');
  const btnAbrirNovoAgendamento = document.getElementById('btnAbrirNovoAgendamento');
  const agModalFechar = document.getElementById('agModalFechar');
  const agModalVoltar = document.getElementById('agModalVoltar');

  function syncBodyModalOpen(){
    const anyOpen = document.querySelectorAll('.auth-modal:not(.hidden)').length > 0;
    document.body.classList.toggle('modal-open', anyOpen);
  }

  function openModalNovoAgendamento(){
    if (!modalNovoAgendamento) return;
    modalNovoAgendamento.classList.remove('hidden');
    modalNovoAgendamento.setAttribute('aria-hidden','false');
    syncBodyModalOpen();
    // foco amigável
    setTimeout(()=>{
      const f = document.getElementById('btnAgClientePicker') || document.getElementById('agServico');
      try { f && f.focus(); } catch(e) {}
    }, 0);
  }

  function closeModalNovoAgendamento(){
    if (!modalNovoAgendamento) return;
    modalNovoAgendamento.classList.add('hidden');
    modalNovoAgendamento.setAttribute('aria-hidden','true');
    syncBodyModalOpen();
  }

  if (btnAbrirNovoAgendamento) btnAbrirNovoAgendamento.onclick = openModalNovoAgendamento;
  if (agModalFechar) agModalFechar.onclick = closeModalNovoAgendamento;
  if (agModalVoltar) agModalVoltar.onclick = closeModalNovoAgendamento;
  if (modalNovoAgendamento) {
    const backdrop = modalNovoAgendamento.querySelector('.auth-modal-backdrop[data-close="1"]');
    if (backdrop) backdrop.onclick = closeModalNovoAgendamento;
    document.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape' && !modalNovoAgendamento.classList.contains('hidden')) {
        closeModalNovoAgendamento();
      }
    });
  }

  $('#btnSalvarAn').onclick = salvarAnamnese;
  $$('#tab-anamnese .btn.model').forEach(b=>b.onclick = ()=>gerarModelo(b.dataset.modelo));
  initAnamnese();

  $('#btnExportar').onclick = exportarDados;
  $('#fileImport').addEventListener('change', importarDados);
  $('#btnBackup').onclick = backupManual;
  $('#btnRecuperar').onclick = recuperarUltimo;
  $('#btnRelatorio').onclick = exportarRelatorio;
  if ($('#btnExportAgenda')) $('#btnExportAgenda').onclick = exportAgendaCSV;
  if ($('#btnRelatorioAgendaPdf')) $('#btnRelatorioAgendaPdf').onclick = gerarRelatorioAgendaPdf;
  if ($('#btnExportTx')) $('#btnExportTx').onclick = exportTxCSV;

  function updateAgendaQuickFilterUI(){
    $$('.ag-filtros-rapidos [data-ag-filter]').forEach(btn=>{
      const active = btn.dataset.agFilter === agendaFilter;
      btn.classList.toggle('ag-filter-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
  $$('.ag-filtros-rapidos [data-ag-filter]').forEach(btn=>{
    btn.onclick = ()=>{
      agendaFilter = btn.dataset.agFilter;
      updateAgendaQuickFilterUI();
      renderAgenda();
    };
  });
  updateAgendaQuickFilterUI();

  // V5.1 - Melhoria 02: limpar todos os filtros da Agenda em uma única ação.
  // Mantido aqui, junto aos filtros rápidos, para não alterar a lógica de renderização/gravação.
  const btnLimparFiltrosAgenda = $('#btnLimparFiltrosAgenda');
  if (btnLimparFiltrosAgenda) {
    btnLimparFiltrosAgenda.onclick = ()=>{
      const busca = $('#buscaAgenda');
      const status = $('#agFiltroStatus');
      const responsavel = $('#agFiltroResponsavel');
      if (busca) busca.value = '';
      if (status) status.value = 'all';
      if (responsavel) responsavel.value = 'all';
      agendaFilter = 'all';
      updateAgendaQuickFilterUI();
      renderAgenda();
    };
  }

  $('#btnSalvarCfg').onclick = salvarCfg;
  $('#btnSalvarCores').onclick = salvarCores;

  $('#btnLimparCache').onclick = limparCache;
  $('#btnResetApp').oncli  // navegação
  $('#btnTestar').onclick = testarConexao;
  $('#btnTrocarSenha').onclick = trocarSenha;

  // buscas
  $('#buscaAgenda').oninput = renderAgenda;
  $('#buscaTx').oninput = renderTx;
  $('#buscaCliente').oninput = renderClientes;
  $('#buscaServico').oninput = renderServicos;
  $('#buscaAn').oninput = renderAn;

  // Lógica do Menu Hamburger
  $('#btnMenu').onclick = toggleSidebar;
  document.body.insertAdjacentHTML('beforeend', '<div id="overlay" class="overlay"></div>');
  $('#overlay').onclick = toggleSidebar;

  function toggleSidebar(){
    $('#sidebar').classList.toggle('open');
    $('#overlay').classList.toggle('show');
  }

  // Navegação pelo novo menu lateral
  $$('#navMenu .menu-item').forEach(btn=>{
    btn.onclick = ()=>{
      $$('#navMenu .menu-item').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const id = btn.dataset.tab;
      $$('.tabpane').forEach(p=>p.classList.remove('show'));
      const pane = $(`#tab-${id}`);
      if(pane) pane.classList.add('show');

      // Sempre que voltar para a Agenda, sai do modo de edição
      if(id === 'agenda'){
        agEditId = null;
        const t = $('#agFormTitle');
        if(t) t.textContent = 'Novo Agendamento';
        const btnAg = $('#btnAgendar');
        if(btnAg) btnAg.textContent = 'Agendar Serviço';
        const tabAg = $('#tab-agenda');
        if(tabAg) tabAg.classList.remove('edit-mode');

        // Agenda normal sempre abre sem filtros ocultos: mostra anteriores, hoje e futuros.
        agendaFilter = 'all';
        const buscaAgenda = $('#buscaAgenda');
        const statusAgenda = $('#agFiltroStatus');
        const respAgenda = $('#agFiltroResponsavel');
        if(buscaAgenda) buscaAgenda.value = '';
        if(statusAgenda) statusAgenda.value = 'all';
        if(respAgenda) respAgenda.value = 'all';
        try{ updateAgendaFilterButtonsV51(); }catch(e){}
        try{ renderAgenda(); }catch(e){}
      }

      if(id === 'meu-usuario'){
        renderMeuUsuario();
      }

      toggleSidebar(); // Fecha o menu após a seleção
    };
  });

// Notificações: verificação leve (1x/min) sem loops pesados
try{
  if(!window.__notifTimer){
    window.__notifTimer = setInterval(()=>{ try{ renderNotifications(); }catch(e){} }, 60000);
  }
  // Primeira renderização
  renderNotifications();
}catch(e){}

}
// USUÁRIOS
function renderPerfis(){
  const sel = $('#selPerfil');
  if (!sel) return;
  sel.innerHTML = '<option value="">Escolha seu perfil</option>';
  state.perfis.forEach(p=>{
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.nome;
    sel.appendChild(opt);
  });
}


async function integrarUsuarioAoSistema(userEmail) {
  // Cloud-only: cada login vê apenas seus dados (uid).
  const emailLower = (userEmail || '').toLowerCase();

  // lembrar e-mail (opcional)
  const rememberEl = document.getElementById('rememberLogin');
  if (rememberEl && rememberEl.checked) {
    try { localStorage.setItem('studioLH__remember_email', emailLower); } catch(e){}
  } else {
    try { localStorage.removeItem('studioLH__remember_email'); } catch(e){}
  }

  if (!auth || !auth.currentUser) {
    setAuthMessage('Usuário não autenticado.');
    return;
  }

  try{
    setAuthMessage('');
    const uidStr = String(auth.currentUser.uid);
    await loadPerfil(uidStr);
  }catch(e){
    console.error(e);
    setAuthMessage('Não foi possível carregar seus dados na nuvem. Verifique Firestore/Auth.');
  }
}


function entrarSistema(){
  if (!auth) {
    alert('Login indisponível: Firebase Auth não está configurado.');
    return;
  }
  const emailEl = document.getElementById('emailLogin');
  const passEl  = document.getElementById('senhaLogin');
  if (!emailEl || !passEl) {
    alert('Campos de login não encontrados.');
    return;
  }
  const email = emailEl.value.trim();
  const senha = passEl.value;
  if (!email || !senha) {
    setAuthMessage('Informe e-mail e senha.');
    return;
  }
  setAuthMessage('Entrando...');

  auth.signInWithEmailAndPassword(email, senha)
    .then((cred)=>{
      const user = cred && cred.user ? cred.user : null;
      const userEmail = (user && user.email ? user.email : email).toLowerCase();

      passEl.value = '';

      integrarUsuarioAoSistema(userEmail);
    })
    .catch(e=>{
      console.error(e);
      setAuthMessage(translateFirebaseError(e.code || ''));
    });
}

function onClickCriarConta(){
  if (!modoCriarConta) {
    // entra no modo de cadastro
    setAuthMode('signup');
    const confInput = document.getElementById('senhaLoginConf');
    if (confInput) confInput.focus();
    return;
  }

  // Já está em modoCriarConta: faz o cadastro de fato
  cadastrarUsuario();
}


async function cadastrarUsuario(){
  if (!auth) {
    alert('Cadastro indisponível: Firebase Auth não está configurado.');
    return;
  }

  const emailEl = document.getElementById('emailLogin');
  const passEl  = document.getElementById('senhaLogin');
  const confEl  = document.getElementById('senhaLoginConf');

  if (!emailEl || !passEl) {
    alert('Campos de cadastro não encontrados.');
    return;
  }

  const email = emailEl.value.trim();
  const senha = passEl.value;
  const senhaConf = confEl ? confEl.value : '';

  if (!email || !senha) {
    setAuthMessage('Informe e-mail e senha para cadastro.');
    return;
  }
  const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailValido) {
    setAuthMessage('Informe um e-mail válido.');
    return;
  }
  if (!senhaConf) {
    setAuthMessage('Confirme a senha para cadastro.');
    return;
  }
  if (senha !== senhaConf) {
    setAuthMessage('As senhas não conferem.');
    return;
  }

  setAuthMessage('Criando conta...');
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, senha);
    const user = cred && cred.user ? cred.user : null;
    const emailLower = (user && user.email ? user.email : email).toLowerCase();

    // Cria um novo perfil administrador para este e-mail.
    // Usa o UID do Firebase Auth como id do perfil para facilitar backup/restore.
    const id = (user && user.uid) ? String(user.uid) : uid();
    state.perfis = state.perfis || [];
    const adminPerfil = {
      id,
      nome: '👑 Administrador',
      email: emailLower,
      emailLower,
      login: emailLower,
      senhaHash: '',
      isAdmin: true,
      ownerId: id,
      tipo: 'admin',
      situacao: 'ativo',
      ativo: true
    };
    state.perfis.push(adminPerfil);
    if (window.db) await db.collection(PERFIS_COLLECTION).doc(id).set(adminPerfil, {merge:true});

    // Limpa campos
    passEl.value = '';
    if (confEl) confEl.value = '';

    setAuthMessage('Conta criada com sucesso! Você já pode usar o sistema.');

    // Integra e entra com este perfil (também respeita "lembrar de mim")
    integrarUsuarioAoSistema(emailLower);
  } catch(e){
    console.error(e);
    setAuthMessage(translateFirebaseError(e.code || ''));
  }
}


async function entrarComGoogle(){
  if (!auth) {
    alert('Login indisponível: Firebase Auth não está configurado.');
    return;
  }

  const provider = new firebase.auth.GoogleAuthProvider();

  // Sugere ao Google mostrar a lista de contas já logadas no dispositivo/navegador
  provider.setCustomParameters({
    prompt: 'select_account'
  });

  setAuthMessage('Abrindo Google...');

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');

  try {
    if (isMobile) {
      // Em muitos navegadores mobile / PWA o popup é bloqueado.
      // Nesses casos fazemos o fluxo via redirect.
      await auth.signInWithRedirect(provider);
      return; // o restante será tratado em auth.getRedirectResult no init()
    } else {
      const cred = await auth.signInWithPopup(provider);
      const user = cred && cred.user ? cred.user : null;
      if (!user || !user.email) {
        setAuthMessage('Não foi possível obter o e-mail da sua conta Google.');
        return;
      }
      const emailLower = user.email.toLowerCase();
      integrarUsuarioAoSistema(emailLower);
    }
  } catch(e){
    console.error(e);
    // Se o popup for bloqueado, tenta redirect como fallback
    if (e && e.code === 'auth/popup-blocked') {
      try {
        await auth.signInWithRedirect(provider);
        return;
      } catch(e2){
        console.error(e2);
        setAuthMessage(translateFirebaseError(e2.code || ''));
      }
    } else {
      setAuthMessage(translateFirebaseError(e.code || ''));
    }
  }
}
function onClickEsqueciSenha(){
  setAuthMode('forgot');
  const emailEl = document.getElementById('emailLogin');
  if (emailEl && !emailEl.value) {
    emailEl.focus();
  }
}

async function resetSenhaFirebase(){
  if (!auth) {
    alert('Recuperação de senha indisponível: Firebase Auth não está configurado.');
    return;
  }
  const emailEl = document.getElementById('emailLogin');
  if (!emailEl) {
    alert('Campo de e-mail não encontrado.');
    return;
  }
  const email = emailEl.value.trim();
  if (!email) {
    setAuthMessage('Informe o e-mail para recuperar a senha.');
    return;
  }
  setAuthMessage('Enviando e-mail de redefinição...');
  try {
    await auth.sendPasswordResetEmail(email);
    setAuthMessage('E-mail de redefinição enviado. Verifique sua caixa de entrada.');
  } catch(e){
    console.error(e);
    setAuthMessage(translateFirebaseError(e.code || ''));
  }
}

async function sairSistema(){
  try {
    stopPerfisListener();
    if (auth) await auth.signOut();
  } catch(e){
    console.error(e);
  }
  location.reload();
}



function onFuncionarioAdicionado(novoPerfil){
  try {
    // Atualiza os dados locais / listas
    if (typeof renderPerfis === 'function') renderPerfis();
    if (typeof renderFuncionarios === 'function') renderFuncionarios();
    if (typeof renderUsuarios === 'function') renderUsuarios();

    // Volta da tela de cadastro para a lista de funcionários
    const listView = document.getElementById('usuariosListView');
    const cadView = document.getElementById('usuariosCadastroView');
    if (listView && cadView) {
      cadView.classList.add('hidden');
      listView.classList.remove('hidden');
    }
  } catch(e){
    console.error(e);
    try { if (typeof renderPerfis === 'function') renderPerfis(); } catch(_) {}
  }
}
function addFuncionarioUsuarios(){
  if (!isPerfilAdmin(state.perfilId)) {
    alert('Apenas o administrador pode adicionar novos perfis/funcionários.');
    return;
  }

  const nomeEl = $('#usNome');
  const emailEl = $('#usEmail');
  const senhaEl = $('#usSenha');
  const senhaConfEl = $('#usSenhaConf');
  const cargoEl = $('#usCargo');
  const setorEl = $('#usSetor');
  const situacaoEl = $('#usSituacao');

  const nome = nomeEl ? nomeEl.value.trim() : '';
  const email = emailEl ? emailEl.value.trim() : '';
  const emailLower = email.toLowerCase();
  const senha = senhaEl ? senhaEl.value.trim() : '';
  const senhaConf = senhaConfEl ? senhaConfEl.value.trim() : '';

  const cargo = cargoEl ? cargoEl.value.trim() : '';
  const setor = setorEl ? setorEl.value.trim() : '';
  const situacao = situacaoEl && situacaoEl.value ? situacaoEl.value : 'ativo';

  if (!nome) {
    alert('O nome do funcionário é obrigatório.');
    return;
  }
  if (!email) {
    alert('O e-mail do funcionário é obrigatório.');
    return;
  }
  if (!senha) {
    alert('A senha do funcionário é obrigatória.');
    return;
  }
  if (senha.length < 6) {
    alert('A senha deve ter pelo menos 6 caracteres.');
    return;
  }
  if (senha !== senhaConf) {
    alert('A confirmação de senha não confere.');
    return;
  }

  if (!auth || typeof firebase === 'undefined') {
    alert('Não foi possível acessar o Firebase Auth. Verifique sua conexão.');
    return;
  }

  // Cria usuário no Firebase Auth usando um app secundário,
  // para não desconectar o administrador atual.
  let secondaryApp = null;
  (async () => {
    try {
      if (typeof firebaseConfig === 'undefined') {
        throw new Error('firebaseConfig não está disponível.');
      }

      secondaryApp = firebase.apps.find(a => a.name === 'secondary') || firebase.initializeApp(firebaseConfig, 'secondary');
      const secondaryAuth = secondaryApp.auth();

      const created = await secondaryAuth.createUserWithEmailAndPassword(email, senha);

      // IMPORTANTÍSSIMO: use o UID real do Firebase Auth como id do perfil.
      // Isso evita que o funcionário vire "admin" por falta de correspondência
      // entre login (uid) e perfil salvo.
      const createdUid = created && created.user && created.user.uid ? String(created.user.uid) : uid();
      const id = createdUid;
      const novoPerfil = {
        id,
        nome,
        email,
        emailLower,
        senhaHash: '',
        isAdmin: false,
        // liga este funcionário ao administrador (dono) que cadastrou
        ownerId: String(getDataOwnerId() || state.perfilId),
        cargo,
        setor,
        situacao,
        ativo: String(situacao) === 'ativo',
        permissions: {
          agenda: !!($('#usPermAgenda') && $('#usPermAgenda').checked),
          clientes: !!($('#usPermClientes') && $('#usPermClientes').checked),
          financeiro: !!($('#usPermFinanceiro') && $('#usPermFinanceiro').checked),
          anamnese: !!($('#usPermAnamnese') && $('#usPermAnamnese').checked)
        }
      };

            // Salva também no Firestore em perfis_usuarios/{uid} (fonte de verdade na nuvem)
      try {
        if (window.db) {
          const ref = db.collection(PERFIS_COLLECTION).doc(String(id));
          const payload = Object.assign({}, novoPerfil, {
            // compatibilidade multi-perfil / consultas
            masterPerfilId: String(getDataOwnerId() || state.perfilId),
            tipo: 'funcionario',
            ativo: String(situacao) === 'ativo',
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          await ref.set(payload, { merge: true });
        }
      } catch (e) {
        console.error('Erro ao salvar funcionário em perfis_usuarios', e);
        const friendly = translateFirebaseError(e.code || '');
        alert(friendly || 'Usuário criado, mas não foi possível salvar o funcionário na nuvem (perfis_usuarios).');
      }

state.perfis.push(novoPerfil);
      savePerfis();
      ensurePerfilData(id);

      if (nomeEl) nomeEl.value = '';
      if (emailEl) emailEl.value = '';
      if (senhaEl) senhaEl.value = '';
      if (senhaConfEl) senhaConfEl.value = '';

      alert(`Funcionário ${nome} adicionado com sucesso!`);

      onFuncionarioAdicionado(novoPerfil);
  // Trata retorno do login com Google via redirect
  try {
    if (auth && typeof auth.getRedirectResult === 'function') {
      auth.getRedirectResult().then(function(cred){
        if (cred && cred.user && cred.user.email) {
          const emailLower = cred.user.email.toLowerCase();
          integrarUsuarioAoSistema(emailLower);
        }
      }).catch(function(e){
        console.error(e);
      });
    }
  } catch(e) {
    console.error(e);
  }

    } catch (e) {
      console.error(e);
      const friendly = translateFirebaseError(e.code || '');
      alert(friendly || 'Erro ao criar usuário no Firebase Auth.');
    } finally {
      if (secondaryApp) {
        try { await secondaryApp.delete(); } catch (_) {}
      }
    }
  })();
}


function renderUsuarios(){
  const perfilAtual = getPerfilAtual();
  const isAdmin = perfilAtual && isPerfilAdmin(perfilAtual.id);

  if ($('#usrAtual')) {
    $('#usrAtual').textContent = perfilAtual ? perfilAtual.nome : '—';
  }
  if ($('#usrTot')) {
    $('#usrTot').textContent = (state.perfis || []).length;
  }
  if ($('#usrAtivos')) {
    const total = (state.perfis || []).filter(p => !isPerfilAdmin(p.id)).length;
    $('#usrAtivos').textContent = total;
  }
  if ($('#usrLogin')) {
    $('#usrLogin').textContent = state.data.lastLogin
      ? new Date(state.data.lastLogin).toLocaleString('pt-BR')
      : '—';
  }

  const box = $('#listaUsuarios');
  if (!box) return;
  box.innerHTML = '';

  if (!isAdmin){
    const aviso = document.createElement('p');
    aviso.className = 'muted';
    aviso.style.marginTop = '8px';
    aviso.textContent = 'Somente o administrador pode gerenciar outros perfis.';
    box.appendChild(aviso);
  }
}

function renderFuncionarios(){
  const box = $('#listaFuncionarios'); 
  if (!box) return;
  box.innerHTML='';

  const perfilAtual = getPerfilAtual();
  const isAdmin = perfilAtual && isPerfilAdmin(perfilAtual.id);

  if (!isAdmin){
    box.innerHTML = '<p class="muted">Apenas o administrador pode visualizar ou alterar funcionários.</p>';
    return;
  }

  // Filtra apenas os perfis que não são o Administrador
  const funcionariosBase = (state.perfis || []).filter(p => !isPerfilAdmin(p.id));

  // Por padrão, esconde inativos. Use o botão "Mostrar inativos" para exibir todos.
  const funcionarios = state.mostrarInativos
    ? funcionariosBase
    : funcionariosBase.filter(isFuncionarioAtivo);

  if(funcionarios.length === 0){
    box.innerHTML = '<p class="muted">Nenhum funcionário cadastrado.</p>';
    return;
  }

  funcionarios.forEach(p=>{
    const ativoBool = (p.ativo !== false) && (String(p.situacao || '').toLowerCase() !== 'inativo');
    const situacao = ativoBool ? 'ativo' : 'inativo';
    const situacaoLabel = situacao === 'ativo' ? 'Ativo' : 'Inativo';
    const badgeClass = situacao === 'ativo' ? 'badge-success' : 'badge-muted';
    const acaoLabel = situacao === 'ativo' ? 'Inativar' : 'Ativar';
    const novoAtivo = situacao !== 'ativo';
    const cargo = p.cargo || '';
    const setor = p.setor || '';
    const perms = getPerfilPermissions(p);
    const permsLabel = Object.entries({agenda:'Agenda',clientes:'Clientes',financeiro:'Financeiro',anamnese:'Anamnese'}).filter(([k])=>perms[k]!==false).map(([,v])=>v).join(', ') || 'Sem acesso';

    const div = document.createElement('div');
    div.className='item row';
    div.innerHTML = `
      <div class="flex1">
        <strong>${escapeHtml(p.nome || '-')}</strong>
        <div class="muted">
          ${escapeHtml(cargo ? cargo : 'Cargo não informado')}
          ${escapeHtml(setor ? ' • ' + setor : '')}
        </div>
      </div>
      <div class="flex1" style="display:flex;flex-direction:column;gap:4px;align-items:flex-start;">
        <span class="muted">${escapeHtml(p.email || '-')}</span>
        <span class="badge ${badgeClass}">${situacaoLabel}</span>
        <span class="muted" style="font-size:11px">Acessos: ${escapeHtml(permsLabel)}</span>
      </div>
      <button class="btn ghost sm" onclick="editarPermissoesFuncionario('${p.id}')"><i class="fa-solid fa-key"></i> Permissões</button>
      <button class="btn sm" onclick="toggleFuncionarioAtivo('${p.id}', ${novoAtivo})">${acaoLabel}</button>
      <button class="btn danger sm" onclick="removerFuncionario('${p.id}')"><i class="fa-solid fa-trash"></i> Remover</button>
    `;
    box.appendChild(div);
  });
}

function editarPermissoesFuncionario(id){
  if(!isPerfilAdmin(state.perfilId)) return;
  const p=(state.perfis||[]).find(x=>String(x.id)===String(id)); if(!p) return;
  const cur=getPerfilPermissions(p);
  const overlay=document.createElement('div'); overlay.className='auth-modal'; overlay.id='modalPermissoesV4';
  overlay.innerHTML=`<div class="auth-modal-backdrop"></div><div class="auth-modal-dialog" role="dialog" aria-modal="true"><div class="auth-modal-header"><h2>Permissões — ${escapeHtml(p.nome||'Funcionário')}</h2><button class="auth-modal-x" type="button">✕</button></div><div class="auth-modal-body"><p class="muted">Escolha as áreas que este funcionário pode acessar.</p>${[['agenda','Agenda'],['clientes','Clientes'],['financeiro','Financeiro'],['anamnese','Anamnese']].map(([k,l])=>`<label class="check" style="display:block;margin:12px 0"><input type="checkbox" data-perm="${k}" ${cur[k]!==false?'checked':''}/> ${l}</label>`).join('')}<div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn success" id="savePermV4">Salvar permissões</button></div></div></div>`;
  document.body.appendChild(overlay); document.body.classList.add('modal-open');
  const close=()=>{overlay.remove(); document.body.classList.remove('modal-open');}; overlay.querySelector('.auth-modal-backdrop').onclick=close; overlay.querySelector('.auth-modal-x').onclick=close;
  overlay.querySelector('#savePermV4').onclick=async()=>{ const permissions={}; overlay.querySelectorAll('[data-perm]').forEach(el=>permissions[el.dataset.perm]=el.checked); try{ await db.collection(PERFIS_COLLECTION).doc(String(id)).set({permissions,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true}); p.permissions=permissions; auditLog('update','funcionario',id,'Permissões de '+(p.nome||'funcionário')+' atualizadas',{permissions}); renderFuncionarios(); close(); toast('Permissões atualizadas.'); }catch(e){console.error(e); alert('Não foi possível salvar as permissões.');} };
}

async function toggleFuncionarioAtivo(id, ativo){
  try{
    if (!isPerfilAdmin(state.perfilId)) {
      alert('Apenas o administrador pode ativar/inativar funcionários.');
      return;
    }
    const uidStr = String(id);
    const novoAtivo = !!ativo;
    const novaSituacao = novoAtivo ? 'ativo' : 'inativo';

    // Atualiza Firestore (fonte de verdade)
    if (window.db) {
      await db.collection(PERFIS_COLLECTION).doc(uidStr).set({
        ativo: novoAtivo,
        situacao: novaSituacao,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    // Atualiza cache em memória (UI imediata)
    const p = (state.perfis || []).find(x => String(x.id) === uidStr);
    if (p){
      p.ativo = novoAtivo;
      p.situacao = novaSituacao;
    }

    // Se foi inativado, oferecer opção de limpar faturamento
    if (!novoAtivo) {
      try{
        if (confirm('Funcionário inativado. Deseja também APAGAR o faturamento (financeiro) deste funcionário?')) {
          await limparFaturamentoFuncionario(uidStr);
        }
      }catch(_){
      }
    }

    renderFuncionarios();
    renderUsuarios();
  }catch(e){
    console.error(e);
    alert('Não foi possível atualizar a situação no Firebase. Verifique as Regras do Firestore.');
  }
}

async function removerFuncionario(id){
  try{
    if (!isPerfilAdmin(state.perfilId)) return alert('Apenas o administrador pode remover funcionários.');
    if(!confirm('Deseja desativar este funcionário?\n\nA conta do Firebase Authentication continuará existindo, mas o acesso ao estabelecimento será bloqueado.')) return;
    const uidStr = String(id);
    if (uidStr === getCurrentActorId()) return alert('O administrador não pode desativar a própria conta por esta tela.');
    if (window.db) {
      await db.collection(PERFIS_COLLECTION).doc(uidStr).set({
        ativo:false, situacao:'inativo', disabledAt:new Date().toISOString()
      }, {merge:true});
    }
    const p = (state.perfis||[]).find(x=>String(x.id)===uidStr);
    if (p){ p.ativo=false; p.situacao='inativo'; }
    renderPerfis(); renderFuncionarios(); renderUsuarios();
    toast('Funcionário desativado. O acesso ao estabelecimento foi bloqueado.');
  }catch(e){
    console.error(e);
    alert('Não foi possível desativar no Firebase. Verifique as Regras do Firestore.');
  }
}
async function limparFaturamentoFuncionario(funcionarioUid){
  try{
    if (!isPerfilAdmin(state.perfilId)) {
      alert('Apenas o administrador pode limpar faturamento.');
      return;
    }
    const uidStr = String(funcionarioUid);
    if (!confirm('Isso vai APAGAR todo o faturamento (lançamentos financeiros) deste funcionário. Deseja continuar?')) return;

    if (!window.db) {
      alert('Firestore não inicializado.');
      return;
    }

    const rootRef = db.collection('perfis').doc(String(getDataOwnerId())).collection('tx');
    // Deleta em lotes (batch) para evitar limite de 500
    while (true){
      const snap = await rootRef.where('createdByUid','==',uidStr).limit(450).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach(d=>batch.delete(d.ref));
      await batch.commit();
      // continua até esvaziar
    }

    // atualiza visão do dono se estiver aberta
    try{ renderVisaoDono(); }catch(_){}
  }catch(e){
    console.error(e);
    const msg = (e && (e.code||e.message)) ? String(e.code||e.message) : '';
    if (/permission-denied/i.test(msg)) {
      alert('Sem permissão para limpar faturamento. Ajuste as Rules para permitir o administrador apagar em perfis/{uid}/tx.');
    } else {
      alert('Não foi possível limpar o faturamento.');
    }
  }
}


/* ======= AGENDA ======= */

function handleMeuUsuarioImagemChange(evt){
  const file = evt.target.files && evt.target.files[0];
  if(!file) return;
  if(file.type && !file.type.startsWith('image/')){
    setMeuUsuarioMessage('Selecione uma imagem válida.', true);
    return;
  }
  const reader = new FileReader();
  reader.onload = e=>{
    const perfil = getPerfilAtual();
    if(!perfil) return;
    perfil.avatar = e.target.result;
    savePerfis();
    atualizarAvatarPerfil(perfil);
    renderSidebarPerfil();
    setMeuUsuarioMessage('Imagem atualizada com sucesso.', false);
  };
  reader.readAsDataURL(file);
}

function salvarAgendamento(){
  const idc = $('#agCliente').value;
  const cliente = state.data.clientes.find(c=>c.id===idc);
  if(!cliente) return alert('Selecione um cliente.');
  const formInfo  = syncAgFormHiddenFields() || {};
  const inicioData = formInfo.inicioData || $('#agData').value || todayISO();
  const inicioHora = formInfo.inicioHora || $('#agHora').value;
  const fimData    = formInfo.fimData    || inicioData;
  const fimHora    = formInfo.fimHora    || '';
  const diaInteiro = !!formInfo.diaInteiro;

  const isEdit = !!agEditId;
  const existing = isEdit ? state.data.agenda.find(x=>x.id===agEditId) : null;
  const id = existing ? existing.id : uid();

  const obj = {
    id,
    clienteId: idc, clienteNome: cliente.nome,
    servico: $('#agServico').value.trim(),
    data: inicioData,
    dataBr: (inicioData || todayISO()).split('-').reverse().join('/'),
    hora: diaInteiro ? 'Dia inteiro' : (inicioHora || ''),
    diaInteiro,
    inicioData,
    inicioHora,
    fimData,
    fimHora,
    valor: parseMoney($('#agValor').value),
    status: $('#agStatus').value,
    obs: $('#agObs').value.trim(),
    responsavelUid: ($('#agResponsavel') && $('#agResponsavel').value) || getCurrentActorId(),
    responsavelNome: ($('#agResponsavel') && $('#agResponsavel').selectedOptions[0] ? $('#agResponsavel').selectedOptions[0].textContent : getCurrentActorName()),
    createdByUid: existing ? (existing.createdByUid||'') : getCurrentActorId(),
    createdByName: existing ? (existing.createdByName||'') : getCurrentActorName(),
    createdAt: existing ? (existing.createdAt||new Date().toISOString()) : new Date().toISOString(),
    updatedByUid: getCurrentActorId(), updatedByName:getCurrentActorName(), updatedAt:new Date().toISOString()
  };

  // Verifica conflitos de horário simples
  const parseMinutes = (h) => {
    if(!h) return null;
    const [hh,mm] = h.split(':').map(Number);
    return hh*60 + (mm||0);
  };

  const novoIni = parseMinutes(inicioHora);
  // V5.1 - Melhorias 10-12: conflito por profissional. Quando não existe hora final,
  // tratamos o horário inicial como um intervalo mínimo de 1 minuto para detectar duplicidade exata.
  const novoFim = fimHora ? parseMinutes(fimHora) : (novoIni == null ? null : novoIni + 1);
  const responsavelNovo = String(obj.responsavelUid || '');

  const conflitoEncontrado = state.data.agenda.find(x=>{
    const dataX = String(x.inicioData || x.data || '').slice(0,10);
    if(dataX !== String(obj.data || '').slice(0,10)) return false;
    if(x.id === obj.id) return false;
    if(String(x.status || 'agendado').trim().toLowerCase() === 'cancelado') return false;
    const responsavelX = String(x.responsavelUid || x.createdByUid || '');
    if(responsavelNovo && responsavelX && responsavelX !== responsavelNovo) return false;
    if(x.diaInteiro || obj.diaInteiro) return true;
    const xIni = parseMinutes(x.inicioHora || (x.hora === 'Dia inteiro' ? '' : x.hora));
    const xFimRaw = x.fimHora ? parseMinutes(x.fimHora) : null;
    const xFim = xFimRaw == null ? (xIni == null ? null : xIni + 1) : xFimRaw;
    if(xIni==null || novoIni==null || xFim==null || novoFim==null) return false;
    return Math.max(xIni, novoIni) < Math.min(xFim, novoFim);
  });

  if(conflitoEncontrado){
    const prof = obj.responsavelNome || 'profissional selecionado';
    const horaConflito = conflitoEncontrado.diaInteiro ? 'dia inteiro' : (conflitoEncontrado.inicioHora || conflitoEncontrado.hora || 'horário informado');
    const ok = confirm(`Conflito de horário: ${prof} já possui um agendamento às ${horaConflito} nessa data. Deseja salvar mesmo assim?`);
    if(!ok) return;
  }

  if(existing){
    Object.assign(existing, obj);
    auditLog('update','agenda',obj.id,'Agendamento de '+(obj.clienteNome||'cliente')+' atualizado');
  } else {
    state.data.agenda.push(obj);
    auditLog('create','agenda',obj.id,'Agendamento de '+(obj.clienteNome||'cliente')+' criado');
  }
  savePerfil();

  // Limpa estado de edição e formulário
  agEditId = null;
  $('#btnAgendar').textContent = 'Agendar Serviço';
  const tAg = $('#agFormTitle');
  if(tAg) tAg.textContent = 'Novo Agendamento';
  const tabAg = $('#tab-agenda');
  if(tabAg) tabAg.classList.remove('edit-mode');
  $('#agServico').value='';
  $('#agObs').value='';
  // imagem do agendamento removida

  renderAgenda();
  // Atualiza KPIs (Previsto/Concluído) em tempo real
  try { renderAgendaResumo(); } catch(e) {}
  renderMainCalendar(); // Atualiza o calendário principal para mostrar o novo agendamento

  // Fecha a modal do formulário (se estiver aberta)
  const m = document.getElementById('modalNovoAgendamento');
  if (m && !m.classList.contains('hidden')) {
    m.classList.add('hidden');
    m.setAttribute('aria-hidden','true');
    const anyOpen = document.querySelectorAll('.auth-modal:not(.hidden)').length > 0;
    document.body.classList.toggle('modal-open', anyOpen);
  }
}
function delAgendamento(id){
  const old=state.data.agenda.find(a=>a.id===id);
  auditLog('delete','agenda',id,'Agendamento de '+((old&&old.clienteNome)||'cliente')+' excluído');
  state.data.agenda = state.data.agenda.filter(a=>a.id!==id);
  savePerfil();
  renderAgenda();
  // Atualiza KPIs (Previsto/Concluído) em tempo real
  try { renderAgendaResumo(); } catch(e) {}
  renderMainCalendar(); // Atualiza o calendário principal para remover o agendamento
}

function editAgendamento(id){
  const a = state.data.agenda.find(x=>x.id===id);
  if(!a) return;

  agEditId = id;
  try{ populateResponsaveisV4(); if($('#agResponsavel')) $('#agResponsavel').value=a.responsavelUid||a.createdByUid||getCurrentActorId(); }catch(e){}

  // Abre a aba de Agenda (modo edição isolado)
  $$('.tabpane').forEach(p=>p.classList.remove('show'));
  const tabAg = $('#tab-agenda');
  if(tabAg){
    tabAg.classList.add('show');
    tabAg.classList.add('edit-mode');
  }
  $$('#navMenu .menu-item').forEach(b=>b.classList.remove('active'));
  const agendaBtn = $$('#navMenu .menu-item[data-tab="agenda"]')[0];
  if(agendaBtn) agendaBtn.classList.add('active');

  // Ajusta textos para modo de edição
  const tAg = $('#agFormTitle');
  if(tAg) tAg.textContent = 'Editar Agendamento';
  const btnAg = $('#btnAgendar');
  if(btnAg) btnAg.textContent = 'Salvar alterações';

  // Preenche os campos do formulário
  $('#agCliente').value   = a.clienteId || '';
  $('#agServico').value   = a.servico || '';
  $('#agValor').value     = (Number(a.valor||0)).toFixed(2).replace('.',',');
  $('#agStatus').value    = a.status || 'agendado';
  $('#agObs').value       = a.obs || '';

  // Dia inteiro / datas e horários
  if ($('#agDiaInteiro')) $('#agDiaInteiro').checked = !!a.diaInteiro;
  if ($('#agInicioData')) $('#agInicioData').value   = a.inicioData || a.data || todayISO();
  if ($('#agInicioHora')) $('#agInicioHora').value   = a.diaInteiro ? '' : (a.inicioHora || (a.hora === 'Dia inteiro' ? '' : a.hora) || '');
  if ($('#agFimData'))    $('#agFimData').value      = a.fimData || a.inicioData || a.data || '';
  if ($('#agFimHora'))    $('#agFimHora').value      = a.fimHora || '';

  // Atualiza os textos dos pickers (cliente/serviço) para refletir o item selecionado
  try { syncAgClientePicker(); } catch(e) {}
  try { syncAgServicoSelPicker(); } catch(e) {}

  // Abre a modal do formulário
  const m = document.getElementById('modalNovoAgendamento');
  if (m) {
    m.classList.remove('hidden');
    m.setAttribute('aria-hidden','false');
    const anyOpen = document.querySelectorAll('.auth-modal:not(.hidden)').length > 0;
    document.body.classList.toggle('modal-open', anyOpen);
    setTimeout(()=>{ try { $('#agServico').focus(); } catch(_) {} }, 0);
  }

  // imagem do agendamento removida

}

function sendWppReminder(id){
  const a = state.data.agenda.find(x=>x.id===id);
  if(!a) return alert('Agendamento não encontrado.');

  const cliente = state.data.clientes.find(c=>c.id===a.clienteId);
  if(!cliente || !cliente.zap) return alert('Número de WhatsApp do cliente não cadastrado.');

  // Formata a mensagem
  const status = (a.status||'agendado');
  let baseMsg = state.cfg.msgWpp || 'Olá! Lembrete do seu agendamento.';
  if(status==='concluido' && state.cfg.msgWppConcluido) baseMsg = state.cfg.msgWppConcluido;
  if(status==='cancelado' && state.cfg.msgWppCancelado) baseMsg = state.cfg.msgWppCancelado;

  // Monta o texto de horário considerando dia inteiro / início / fim
  let horaTexto = '';
  if (a.diaInteiro) {
    horaTexto = 'dia inteiro';
  } else {
    const inicio = a.inicioHora || a.hora || '';
    const fim    = a.fimHora || '';
    if (inicio && fim) horaTexto = `${inicio} às ${fim}`;
    else horaTexto = inicio || fim || '';
  }

  let msg = baseMsg;
  msg = msg.replace(/{{DATA}}/g, a.dataBr);
  msg = msg.replace(/{{HORA}}/g, horaTexto);
  msg = msg.replace(/{{CLIENTE}}/g, a.clienteNome);
  msg = msg.replace(/{{SERVICO}}/g, a.servico);
  msg = msg.replace(/{{VALOR}}/g, money(a.valor||0, state.cfg.moeda));
  msg = msg.replace(/{{ESTUDIO}}/g, state.cfg.estudio||'');
  msg = msg.replace(/{{PIX}}/g, state.cfg.pixChave||'');

  // Remove caracteres não numéricos do telefone e garante o código do país (55 para Brasil)
  const phone = cliente.zap.replace(/\D/g, '');
  // Garante o formato E.164 (Código do País + DDD + Número)
  // Assume 55 (Brasil) se o número tiver 10 ou 11 dígitos (DDD + Número)
  let fullPhone = phone;
  if (phone.length === 10 || phone.length === 11) {
    fullPhone = '55' + phone;
  }

  const url = `https://wa.me/${fullPhone}?text=${encodeURIComponent(msg)}`;
  console.log('Tentando abrir o WhatsApp com a URL:', url);
  window.open(url, '_blank');
}

// ======= ANIVERSARIANTES (HOJE) =======
function getAniversariantesHoje(){
  const hoje = new Date();
  const mm = String(hoje.getMonth()+1).padStart(2,'0');
  const dd = String(hoje.getDate()).padStart(2,'0');
  const key = `${mm}-${dd}`;

  const clientes = (state.data && Array.isArray(state.data.clientes)) ? state.data.clientes : [];
  return clientes
    .filter(c=>{
      const nasc = (c && c.nasc) ? String(c.nasc) : '';
      // aceita YYYY-MM-DD
      if (nasc.length >= 10 && nasc.includes('-')){
        const part = nasc.slice(5,10);
        return part === key;
      }
      return false;
    })
    .slice()
    .sort((a,b)=>(a.nome||'').localeCompare(b.nome||''));
}



/* ======= NOTIFICAÇÕES (Centro Inteligente) ======= */
const NOTIF_STORE_KEY = 'notifs.v1';

function loadNotifStore(){
  try{
    const raw = localStorage.getItem(NOTIF_STORE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return {
      read: Array.isArray(obj.read) ? obj.read : [],
      dismissed: Array.isArray(obj.dismissed) ? obj.dismissed : [],
      pushed: Array.isArray(obj.pushed) ? obj.pushed : [],
      weeklyShown: Array.isArray(obj.weeklyShown) ? obj.weeklyShown : []
    };
  }catch(e){
    return { read:[], dismissed:[], pushed:[], weeklyShown:[] };
  }
}
function saveNotifStore(store){
  try{ localStorage.setItem(NOTIF_STORE_KEY, JSON.stringify(store||{})); }catch(e){}
}
function notifIdSafe(s){
  return String(s||'')
    .trim()
    .toLowerCase()
    .replace(/\s+/g,'-')
    .replace(/[^a-z0-9\-_.]/g,'')
    .slice(0, 80);
}

function parseAgendaDateTime(a){
  try{
    const d = String(a.data||'').slice(0,10);
    const h = String(a.hora||'').slice(0,5);
    if(!d || d.length<10 || !h || h.length<4) return null;
    const dt = new Date(`${d}T${h}:00`);
    if(isNaN(dt.getTime())) return null;
    return dt;
  }catch(e){ return null; }
}

function isoWeekKey(dt){
  // ISO week key: YYYY-Www
  const d = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  const yyyy = d.getUTCFullYear();
  return `${yyyy}-W${String(weekNo).padStart(2,'0')}`;
}

function requestNotificationPermission(){
  try{
    if(!('Notification' in window)) return;
    if(Notification.permission === 'default'){
      Notification.requestPermission().catch(()=>{});
    }
  }catch(e){}
}

function pushBrowserNotification(title, body){
  try{
    if(!('Notification' in window)) return false;
    if(Notification.permission !== 'granted') return false;
    const n = new Notification(title || 'Notificação', { body: body || '' });
    // Fecha automaticamente para evitar acumular
    setTimeout(()=>{ try{ n.close(); }catch(e){} }, 7000);
    return true;
  }catch(e){ return false; }
}

/**
 * Percorre state.data.agenda e gera notificações de agendamento.
 * Regra: alerta visual (e push, se permitido) a partir do momento em que faltar 12h.
 */
function checkBookingNotifications(now = new Date()){
  const store = loadNotifStore();
  const out = [];
  const agenda = (state && state.data && Array.isArray(state.data.agenda)) ? state.data.agenda : [];

  for(const a of agenda){
    const dt = parseAgendaDateTime(a);
    if(!dt) continue;

    const eventMs = dt.getTime();
    const triggerMs = eventMs - (12 * 60 * 60 * 1000);
    const nowMs = now.getTime();

    // Janela: do trigger até o horário do agendamento (com leve tolerância)
    if(nowMs < triggerMs) continue;
    if(nowMs > eventMs + (2 * 60 * 60 * 1000)) continue; // evita passado antigo

    const id = `booking-${notifIdSafe(a.id || `${a.data}-${a.hora}-${a.clienteNome||a.cliente||''}`)}`;
    if(store.dismissed.includes(id)) continue;

    const dataBr = a.dataBr || (a.data ? a.data.split('-').reverse().join('/') : '');
    const title = 'Agendamento em ~12h';
    const desc = `${a.clienteNome||'Cliente'}${a.servico?` • ${escapeHtml(a.servico||'')}`:''} — ${dataBr} ${a.hora||''}`.trim();

    out.push({
      id,
      kind: 'booking',
      title,
      message: desc,
      ts: triggerMs,
      unread: !store.read.includes(id)
    });

    // Push: dispara uma vez quando entrar na janela do trigger (até 5 min depois)
    if(!store.pushed.includes(id) && nowMs >= triggerMs && nowMs <= triggerMs + (5 * 60 * 1000)){
      if(pushBrowserNotification(title, desc)){
        store.pushed.push(id);
        saveNotifStore(store);
      }
    }
  }

  return out;
}

function getAniversariantesSemana(ref = new Date()){
  const clientes = (state && state.data && Array.isArray(state.data.clientes)) ? state.data.clientes : [];
  // Semana (Mon..Sun) da data ref, no fuso local
  const day = ref.getDay(); // 0..6 (Dom..Sab)
  const diffToMon = (day === 0) ? -6 : (1 - day);
  const monday = new Date(ref);
  monday.setHours(0,0,0,0);
  monday.setDate(monday.getDate() + diffToMon);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  sunday.setHours(23,59,59,999);

  const mmddInRange = (mmdd)=>{
    try{
      const [mm,dd] = mmdd.split('-').map(x=>parseInt(x,10));
      if(!mm || !dd) return null;
      // usa ano atual para comparar janela
      const year = ref.getFullYear();
      const dt = new Date(year, mm-1, dd, 12, 0, 0, 0);
      // Se a janela atravessar ano (ex.: última semana de Dez), também testa ano+1/ano-1
      const candidates = [dt, new Date(year+1, mm-1, dd, 12,0,0,0), new Date(year-1, mm-1, dd, 12,0,0,0)];
      return candidates.some(c=> c.getTime() >= monday.getTime() && c.getTime() <= sunday.getTime());
    }catch(e){ return false; }
  };

  return clientes
    .filter(c=>{
      const nasc = (c && c.nasc) ? String(c.nasc) : '';
      if(nasc.length >= 10 && nasc.includes('-')){
        const mmdd = nasc.slice(5,10);
        return mmddInRange(mmdd);
      }
      return false;
    })
    .slice()
    .sort((a,b)=>(a.nome||'').localeCompare(b.nome||''));
}

function checkBirthdayNotifications(now = new Date()){
  const store = loadNotifStore();
  const out = [];

  // Diária: hoje
  const hoje = getAniversariantesHoje();
  for(const c of hoje){
    const id = `bday-${notifIdSafe(c.id || `${c.nome||'cliente'}-${String(c.nasc||'').slice(5,10)}`)}`;
    if(store.dismissed.includes(id)) continue;
    const title = 'Aniversário hoje 🎉';
    const msg = `Hoje é aniversário de ${c.nome||'um cliente'}! Envie um parabéns.`;
    out.push({ id, kind:'birthday', title, message: msg, ts: now.getTime(), unread: !store.read.includes(id) });
  }

  // Semanal: segunda-feira 08h (mostra uma vez por semana)
  const isMonday = now.getDay() === 1;
  const after8 = (now.getHours() > 8) || (now.getHours() === 8 && now.getMinutes() >= 0);
  if(isMonday && after8){
    const weekKey = isoWeekKey(now);
    const weekId = `bweek-${weekKey}`;
    if(!store.weeklyShown.includes(weekId) && !store.dismissed.includes(weekId)){
      const list = getAniversariantesSemana(now);
      const nomes = list.map(x=>x.nome).filter(Boolean);
      const title = 'Aniversariantes da Semana';
      const msg = nomes.length ? `Aniversariantes da Semana: ${nomes.join(', ')}` : 'Aniversariantes da Semana: nenhum';
      out.push({ id: weekId, kind:'birthday-week', title, message: msg, ts: now.getTime(), unread: !store.read.includes(weekId) });

      // marca como "gerada" para não recriar várias vezes durante a renderização
      store.weeklyShown.push(weekId);
      saveNotifStore(store);
    }
  }

  return out;
}

function computeNotifications(){
  const now = new Date();
  const list = []
    .concat(checkBookingNotifications(now))
    .concat(checkBirthdayNotifications(now));

  // Ordena: mais recente primeiro (por ts)
  list.sort((a,b)=>(b.ts||0)-(a.ts||0));

  // remove duplicadas por id
  const seen = new Set();
  return list.filter(n=>{
    if(!n || !n.id) return false;
    if(seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}

function renderNotifications(){
  const panel = document.getElementById('notificationsScreen');
  const box = document.getElementById('notificationsList');
  const empty = document.getElementById('notificationsEmpty');
  const dot = document.getElementById('notifDot');
  const btnClear = document.getElementById('btnClearNotifications');
  if(!box) return;

  const store = loadNotifStore();
  const notifs = computeNotifications().filter(n=> !store.dismissed.includes(n.id));

  const unreadCount = notifs.filter(n=>n.unread).length;
  if(dot){
    dot.classList.toggle('hidden', unreadCount === 0);
  }

  box.innerHTML = '';

  if(empty){
    empty.classList.toggle('hidden', notifs.length !== 0);
  }

  const iconFor = (kind)=>{
    if(kind === 'booking') return 'fa-regular fa-clock';
    if(kind === 'birthday' || kind === 'birthday-week') return 'fa-solid fa-gift';
    return 'fa-regular fa-bell';
  };

  notifs.forEach(n=>{
    const row = document.createElement('div');
    row.className = 'notif-item dp-notif-item' + (n.unread ? '' : ' read');
    const meta = n.kind === 'booking' ? 'Lembrete de agendamento' : (n.kind === 'birthday-week' ? 'Resumo semanal' : 'Aniversário');
    row.innerHTML = `
      <div class="notif-left">
        <div class="notif-icon"><i class="${iconFor(n.kind)}"></i></div>
        <div class="notif-msg">
          <strong>${escapeHtml(n.title||'Notificação')}</strong>
          <div>${escapeHtml(n.message||'')}</div>
          <div class="notif-meta">${escapeHtml(meta)}</div>
        </div>
      </div>
      <div class="notif-actions">
        ${n.unread ? `<button class="btn ghost sm" type="button" data-act="read" data-id="${n.id}"><i class="fa-solid fa-check"></i></button>` : ''}
        <button class="btn ghost sm" type="button" data-act="dismiss" data-id="${n.id}"><i class="fa-solid fa-xmark"></i></button>
      </div>
    `;
    box.appendChild(row);
  });

  // binds
  box.querySelectorAll('[data-act="read"]').forEach(b=>{
    b.onclick = ()=>{
      const id = b.dataset.id;
      const s = loadNotifStore();
      if(id && !s.read.includes(id)) s.read.push(id);
      saveNotifStore(s);
      renderNotifications();
    };
  });
  box.querySelectorAll('[data-act="dismiss"]').forEach(b=>{
    b.onclick = ()=>{
      const id = b.dataset.id;
      const s = loadNotifStore();
      if(id && !s.dismissed.includes(id)) s.dismissed.push(id);
      saveNotifStore(s);
      renderNotifications();
    };
  });

  if(btnClear && !btnClear._bound){
    btnClear._bound = true;
    btnClear.onclick = ()=>{
      const s = loadNotifStore();
      // Dismiss todas marcadas como lidas (somente as que existem agora)
      notifs.filter(n=>!n.unread).forEach(n=>{
        if(!s.dismissed.includes(n.id)) s.dismissed.push(n.id);
      });
      saveNotifStore(s);
      renderNotifications();
    };
  }
}

// Sanitização simples para render (evita inserir HTML arbitrário no painel)
function escapeHtml(str){
  return String(str||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}

function normalizePhoneBR(phoneRaw){
  const digits = String(phoneRaw||'').replace(/\D/g,'');
  if (!digits) return '';
  // Se já veio com código do país (ex: 55 + ...), mantém
  if (digits.length > 11) return digits;
  if (digits.length === 10 || digits.length === 11) return '55' + digits;
  return digits; // fallback
}

function sendWppBirthday(cliente){
  if(!cliente) return;
  if(!cliente.zap) return alert('Número de WhatsApp do cliente não cadastrado.');
  const fullPhone = normalizePhoneBR(cliente.zap);
  if(!fullPhone) return alert('Número de WhatsApp inválido.');
  const msg = `Olá ${cliente.nome||''}! Feliz aniversário! 🎉🎂`;
  const url = `https://wa.me/${fullPhone}?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
}

function renderAniversariantesHoje(){
  const box = document.getElementById('listaAniversariantesHoje');
  if(!box) return;
  const arr = getAniversariantesHoje();
  box.innerHTML = '';
  if(!arr.length){
    box.innerHTML = '<p class="muted">Nenhum aniversariante hoje.</p>';
    return;
  }
  arr.forEach(c=>{
    const div = document.createElement('div');
    div.className = 'aniv-row';
    div.innerHTML = `
      <div class="aniv-left">
        <button class="btn success sm" data-id="${c.id}" title="Enviar WhatsApp"><i class="fa-brands fa-whatsapp"></i></button>
      </div>
      <div class="aniv-right">
        <strong>${escapeHtml(c.nome||'—')}</strong>
        <div class="muted">${escapeHtml(c.zap||'—')}${escapeHtml(c.email ? ' • ' + c.email : '')}</div>
      </div>
    `;
    box.appendChild(div);
  });
  box.querySelectorAll('button[data-id]').forEach(b=>{
    b.onclick = ()=>{
      const c = state.data.clientes.find(x=>x.id===b.dataset.id);
      sendWppBirthday(c);
    };
  });
}

function openModalAniversariantes(){
  const modal = document.getElementById('modalAniversariantes');
  if(!modal) return;
  renderAniversariantesHoje();
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeModalAniversariantes(){
  const modal = document.getElementById('modalAniversariantes');
  if(!modal) return;
  modal.classList.add('hidden');
  const anyOpen = document.querySelectorAll('.auth-modal:not(.hidden)').length > 0;
  document.body.classList.toggle('modal-open', anyOpen);
}

// Navega para a aba "Financeiro" e (opcionalmente) pré-preenche o formulário
function goToFinanceiro(){
  $$('.tabpane').forEach(p=>p.classList.remove('show'));
  $('#tab-financeiro').classList.add('show');
  // Ativar o item do menu lateral "Financeiro"
  $$('#navMenu .menu-item').forEach(b=>b.classList.remove('active'));
  const it = $$('#navMenu .menu-item[data-tab="financeiro"]')[0];
  if (it) it.classList.add('active');
}

// Abre o financeiro e deixa o formulário pronto para o usuário confirmar/editar
function txFromAgendamento(id){
  const a = state.data.agenda.find(x=>x.id===id);
  if(!a) return;
  goToFinanceiro();
  openFormTx('receita');
  $('#txDesc').value = `Serviço: ${escapeHtml(a.servico||'')} • Cliente: ${escapeHtml(a.clienteNome||'')}`;
  $('#txValor').value = (a.valor||0).toFixed(2).replace('.',',');
  $('#txData').value = a.data;
  $('#txCat').value = 'Serviços';
}

// Lança automaticamente a transação (1 clique)
function lancarTxFromAgendamento(id){
  const a = state.data.agenda.find(x=>x.id===id);
  if(!a) return;
  // Evita duplicidade: se já foi lançado, apenas avisa.
  if (a.lancadoFinanceiro || a.txId) {
    toast('');
    return;
  }

  // Cria a transação diretamente (sem abrir tela intermediária)
  const txId = uid();
  const dataISO = a.data || todayISO();
  const obj = {
    id: txId,
    tipo: 'receita',
    desc: `Serviço: ${escapeHtml(a.servico||'')} • Cliente: ${escapeHtml(a.clienteNome||'')}`,
    valor: Number(a.valor||0),
    data: dataISO,
    dataBr: formatDateBR(dataISO),
    cat: 'Serviços',
    // vínculo (útil para rastrear)
    origem: 'agenda',
    origemId: a.id
  };
  state.data.tx.push(obj);

  // marca no agendamento
  a.lancadoFinanceiro = true;
  a.txId = txId;
  a.lancadoFinanceiroEm = new Date().toISOString();

  savePerfil();

  // Atualiza totais/listas em tempo real (sem recarregar)
  try { renderTx(); } catch(e) {}
  try { refreshKpis(); } catch(e) {}
  try { renderAgenda(); } catch(e) {}
  try { renderAgendaResumo(); } catch(e) {}

  // toast removido (pedido do usuário)
}

// V5.1 - Melhoria 10: ações rápidas de status diretamente no card da Agenda.
function atualizarStatusAgendamentoRapido(id, novoStatus){
  const a = state.data.agenda.find(x=>x.id===id);
  if(!a) return alert('Agendamento não encontrado.');
  const anterior = String(a.status || 'agendado');
  if(anterior === novoStatus) return;
  const rotulo = novoStatus === 'concluido' ? 'Concluído' : (novoStatus === 'cancelado' ? 'Cancelado' : 'Agendado');
  if(!confirm(`Alterar o status deste agendamento para ${rotulo}?`)) return;
  a.status = novoStatus;
  a.updatedByUid = getCurrentActorId();
  a.updatedByName = getCurrentActorName();
  a.updatedAt = new Date().toISOString();
  auditLog('update','agenda',a.id,`Status do agendamento de ${a.clienteNome||'cliente'} alterado de ${anterior} para ${novoStatus}`);
  savePerfil();
  renderAgenda();
  try { renderAgendaResumo(); } catch(e) {}
  try { renderMainCalendar(); } catch(e) {}
  try { refreshKpis(); } catch(e) {}
}

function renderAgenda(){
  const buscaEl = $('#buscaAgenda');
  const q = (buscaEl && buscaEl.value ? buscaEl.value : '').toLowerCase();
  const box = $('#listaAgenda');
  if (!box || !state || !state.data || !Array.isArray(state.data.agenda)) return;

  box.innerHTML = '';

  (state.data.agenda || [])
    .slice()
    // V5.1 - Melhoria 09: ordenação cronológica usa o horário atual do agendamento.
    // Registros novos usam inicioHora; registros antigos continuam compatíveis com hora.
    .sort((a,b)=> {
      const dataA = String(a.inicioData || a.data || '');
      const dataB = String(b.inicioData || b.data || '');
      const porData = dataA.localeCompare(dataB);
      if (porData) return porData;
      const horaA = a.diaInteiro ? '00:00' : String(a.inicioHora || a.hora || '23:59');
      const horaB = b.diaInteiro ? '00:00' : String(b.inicioHora || b.hora || '23:59');
      return horaA.localeCompare(horaB);
    })
    .filter(a=>{
      const texto = ((a.servico||'') + (a.obs||'') + (a.clienteNome||'')).toLowerCase();
      const dataBr = (a.dataBr || (a.data ? a.data.split('-').reverse().join('/') : '')).toLowerCase();
      return !q || texto.includes(q) || dataBr.includes(q);
    })
    .filter(a=>{
      const st = ($('#agFiltroStatus') && $('#agFiltroStatus').value) || 'all';
      const resp = ($('#agFiltroResponsavel') && $('#agFiltroResponsavel').value) || 'all';
      if(st !== 'all' && (a.status||'agendado') !== st) return false;
      if(resp !== 'all' && (a.responsavelUid||a.createdByUid||'') !== resp) return false;
      return true;
    })
    .filter(a=>{
      // filtros rápidos: today / tomorrow / week / all
      if (typeof agendaFilter === 'undefined' || agendaFilter === 'all') return true;

      const dataISO = a.inicioData || a.data;
      if (!dataISO || typeof dataISO !== 'string') return true;

      const partes = dataISO.split('-');
      if (partes.length !== 3) return true;
      const [yy, mm, dd] = partes.map(Number);
      if (!yy || !mm || !dd) return true;

      const dt = new Date(yy, mm - 1, dd);
      const hoje = new Date();
      const hojeISO = todayISO();

      if (agendaFilter === 'today') {
        return dataISO === hojeISO;
      }

      if (agendaFilter === 'tomorrow') {
        const amanha = new Date();
        amanha.setDate(amanha.getDate() + 1);
        const amanhaISO = `${amanha.getFullYear()}-${String(amanha.getMonth()+1).padStart(2,'0')}-${String(amanha.getDate()).padStart(2,'0')}`;
        return dataISO === amanhaISO;
      }

      if (agendaFilter === 'week') {
        const inicioSemana = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
        const fimSemana = new Date(inicioSemana);
        fimSemana.setDate(fimSemana.getDate() + 7);
        return dt >= inicioSemana && dt < fimSemana;
      }

      return true;
    })
    .forEach(a=>{
      const div = document.createElement('div');
      div.className = 'item agenda-card';
      div.dataset.status = a.status || 'agendado';

      const jaLancadoFinanceiro = !!(a.lancadoFinanceiro || a.txId);

      const horarioLabel = a.diaInteiro
        ? 'Dia inteiro'
        : (a.inicioHora || a.hora)
          ? `${a.inicioHora || a.hora}${a.fimHora ? ' - ' + a.fimHora : ''}`
          : '';

      const dataBase = a.dataBr || (a.data ? a.data.split('-').reverse().join('/') : '');
      let diaSemana = '';
      if (a.data) {
        const partesDt = a.data.split('-');
        if (partesDt.length === 3) {
          const [yy, mm, dd] = partesDt.map(Number);
          if (yy && mm && dd) {
            const dt = new Date(yy, mm - 1, dd);
            diaSemana = dt.toLocaleDateString('pt-BR', { weekday: 'short' });
          }
        }
      }
      const dataLabel = diaSemana ? `${dataBase} (${diaSemana})` : dataBase;
      // V5.1 - Melhorias 06/07: identificação visual de hoje e amanhã.
      // É apenas apresentação: não altera filtros, status ou dados salvos.
      const hojeISOV51 = todayISO();
      const amanhaV51 = new Date();
      amanhaV51.setDate(amanhaV51.getDate() + 1);
      const amanhaISOV51 = `${amanhaV51.getFullYear()}-${String(amanhaV51.getMonth()+1).padStart(2,'0')}-${String(amanhaV51.getDate()).padStart(2,'0')}`;
      const dataAgendaV51 = String(a.data || '').trim().slice(0, 10);
      const statusAgendaV51 = String(a.status || 'agendado').trim().toLowerCase();
      const isHojeV51 = dataAgendaV51 === hojeISOV51;
      const isAmanhaV51 = dataAgendaV51 === amanhaISOV51;
      // V5.1 - Melhoria 08 (corrigida): normaliza data/status antes da comparação.
      // Assim registros antigos ou sincronizados com pequenas variações de formato também são reconhecidos.
      const isAtrasadoV51 = /^\d{4}-\d{2}-\d{2}$/.test(dataAgendaV51)
        && dataAgendaV51 < hojeISOV51
        && statusAgendaV51 === 'agendado';
      const hojeBadgeV51 = isHojeV51
        ? '<span class="ag-hoje-badge-v51">HOJE</span>'
        : (isAmanhaV51
          ? '<span class="ag-amanha-badge-v51">AMANHÃ</span>'
          : (isAtrasadoV51 ? '<span class="ag-atrasado-badge-v51">ATRASADO</span>' : ''));
      const statusLabel = (a.status || 'agendado').toUpperCase();

      div.innerHTML = `
        <div class="ag-grid">
          <div class="ag-row">
            <div class="ag-col">
              <div class="ag-label">Cliente</div>
              <div class="ag-text ag-cliente">${escapeHtml(a.clienteNome||'')}</div>
            </div>
            <div class="ag-col">
              <div class="ag-label">Data / Hora</div>
              <div class="ag-text ag-datahora">${escapeHtml(dataLabel)}${escapeHtml(horarioLabel ? ' • ' + horarioLabel : '')} ${hojeBadgeV51}</div>
            </div>
          </div>
          <div class="ag-row">
            <div class="ag-col">
              <div class="ag-label">Serviço</div>
              <div class="ag-text ag-servico">${escapeHtml(a.servico||'')}</div>
              <div class="muted" style="font-size:11px;margin-top:3px">Responsável: ${escapeHtml(a.responsavelNome||a.createdByName||'—')}</div>
            </div>
            <div class="ag-col">
              <div class="ag-label">Valor</div>
              <div class="ag-text ag-valor">${money(a.valor, state.cfg.moeda)}</div>
              <div class="ag-fin-resumo-v51 ${jaLancadoFinanceiro ? 'is-ok' : 'is-pendente'}">
                <i class="fa-solid ${jaLancadoFinanceiro ? 'fa-circle-check' : 'fa-clock'}"></i>
                ${jaLancadoFinanceiro ? 'Financeiro lançado' : 'Pendente de lançamento'}
              </div>
            </div>
            <div class="ag-col ag-col-status">
              <div class="ag-label">Status</div>
              <div class="ag-status-tag ag-status-${a.status || 'agendado'}">${statusLabel}</div>
            </div>
          </div>
        </div>
        <div class="row ag-actions" style="margin-top:6px;gap:8px">
          <div class="ag-actions-main">
            <button class="btn ghost xs ag-btn" data-id="${a.id}" data-act="wpp" title="Abrir WhatsApp do cliente com a mensagem do agendamento">
              <i class="fa-brands fa-whatsapp"></i>
              <span>WhatsApp</span>
            </button>
            ${statusAgendaV51 !== 'concluido' ? `<button class="btn ghost xs ag-btn" data-id="${a.id}" data-act="quick_done" title="Marcar como concluído"><i class="fa-solid fa-check"></i><span>Concluir</span></button>` : ''}
            ${statusAgendaV51 !== 'cancelado' ? `<button class="btn ghost xs ag-btn" data-id="${a.id}" data-act="quick_cancel" title="Marcar como cancelado"><i class="fa-solid fa-ban"></i><span>Cancelar</span></button>` : ''}
            <button class="btn ghost xs ag-btn" data-id="${a.id}" data-act="tx">
              <i class="fa-solid fa-coins"></i>
              <span>Financeiro</span>
            </button>
            <button class="btn ghost xs ag-btn ${jaLancadoFinanceiro ? 'is-launched' : ''}" data-id="${a.id}" data-act="tx_lancar" title="${jaLancadoFinanceiro ? 'Já lançado' : 'Lançar'}">
              <i class="fa-solid ${jaLancadoFinanceiro ? 'fa-circle-check' : 'fa-cash-register'}"></i>
              <span>${jaLancadoFinanceiro ? 'Lançado' : 'Lançar'}</span>
            </button>
          </div>
          <div class="ag-actions-secondary">
            <button class="btn ghost xs ag-btn" data-id="${a.id}" data-act="edit">
              <i class="fa-solid fa-pen"></i>
              <span>Editar</span>
            </button>
            <button class="btn danger xs ag-btn" data-id="${a.id}" data-act="del">
              <i class="fa-solid fa-trash"></i>
              <span>Excluir</span>
            </button>
          </div>
        </div>
        `;

      box.appendChild(div);
    });

  // V5.1 - Melhoria 03: informa quantos agendamentos ficaram visíveis após os filtros.
  // Usa apenas os cards já renderizados para não duplicar nem alterar a lógica dos filtros.
  const agendaContagemV51 = $('#agendaContagemV51');
  if (agendaContagemV51) {
    const totalVisivel = box.children.length;
    agendaContagemV51.textContent = totalVisivel === 1
      ? '1 agendamento encontrado'
      : `${totalVisivel} agendamentos encontrados`;

    // V5.1 - Melhoria 05: resumo textual dos filtros ativos.
    // Apenas lê os controles existentes; não altera a lógica de filtragem nem os dados.
    const filtrosAtivosEl = $('#agendaFiltrosAtivosV51');
    if (filtrosAtivosEl) {
      const partesFiltro = [];
      const periodoLabels = { today: 'Hoje', tomorrow: 'Amanhã', week: 'Esta semana' };
      if (typeof agendaFilter !== 'undefined' && agendaFilter !== 'all' && periodoLabels[agendaFilter]) {
        partesFiltro.push(periodoLabels[agendaFilter]);
      }
      const statusEl = $('#agFiltroStatus');
      if (statusEl && statusEl.value !== 'all') {
        partesFiltro.push(`Status: ${statusEl.options[statusEl.selectedIndex]?.text || statusEl.value}`);
      }
      const respEl = $('#agFiltroResponsavel');
      if (respEl && respEl.value !== 'all') {
        partesFiltro.push(`Profissional: ${respEl.options[respEl.selectedIndex]?.text || 'Selecionado'}`);
      }
      if (q) partesFiltro.push(`Busca: ${buscaEl.value.trim()}`);
      filtrosAtivosEl.textContent = partesFiltro.length
        ? `Filtros ativos: ${partesFiltro.join(' • ')}`
        : 'Sem filtros adicionais';
    }

    // V5.1 - Melhoria 04: estado vazio da Agenda.
    // É inserido somente depois da contagem, portanto não interfere nos filtros nem nos dados.
    if (totalVisivel === 0) {
      const vazio = document.createElement('div');
      vazio.className = 'agenda-empty-v51';
      vazio.innerHTML = `
        <i class="fa-regular fa-calendar-xmark" aria-hidden="true"></i>
        <strong>Nenhum agendamento encontrado com esses filtros.</strong>
        <span>Tente alterar os filtros ou limpar a busca atual.</span>
        <button class="btn ghost xs" type="button" id="btnAgendaEmptyLimparV51">Limpar filtros</button>
      `;
      box.appendChild(vazio);
      const btnVazio = $('#btnAgendaEmptyLimparV51');
      if (btnVazio) btnVazio.onclick = () => {
        const btnLimpar = $('#btnLimparFiltrosAgenda');
        if (btnLimpar) btnLimpar.click();
      };
    }
  }

  $$('#listaAgenda [data-act="del"]').forEach(btn=>{
    btn.onclick = (ev)=>{
      const id = ev.currentTarget.dataset.id;
      if (confirm('Excluir este agendamento?')){
        delAgendamento(id);
        refreshKpis();
      }
    };
  });
  $$('#listaAgenda [data-act="wpp"]').forEach(btn=>{
    btn.onclick = (ev)=>{
      const id = ev.currentTarget.dataset.id;
      sendWppReminder(id);
    };
  });
  $$('#listaAgenda [data-act="tx"]').forEach(btn=>{
    btn.onclick = (ev)=>{
      const id = ev.currentTarget.dataset.id;
      txFromAgendamento(id);
    };
  });
  $$('#listaAgenda [data-act="tx_lancar"]').forEach(btn=>{
    btn.onclick = (ev)=>{
      const id = ev.currentTarget.dataset.id;
      lancarTxFromAgendamento(id);
    };
  });
  $$('#listaAgenda [data-act="quick_done"]').forEach(btn=>{
    btn.onclick = (ev)=> atualizarStatusAgendamentoRapido(ev.currentTarget.dataset.id, 'concluido');
  });
  $$('#listaAgenda [data-act="quick_cancel"]').forEach(btn=>{
    btn.onclick = (ev)=> atualizarStatusAgendamentoRapido(ev.currentTarget.dataset.id, 'cancelado');
  });
  $$('#listaAgenda [data-act="edit"]').forEach(btn=>{
    btn.onclick = (ev)=>{
      const id = ev.currentTarget.dataset.id;
      editAgendamento(id);
    };
  });
}



function gerarRelatorioAgendaPdf(){
  if (!state || !state.data || !Array.isArray(state.data.agenda)) {
    alert('Nenhum dado de agenda disponível.');
    return;
  }

  const win = window.open('', '_blank');
  if (!win) {
    alert('Não foi possível abrir o relatório. Verifique bloqueio de pop-ups.');
    return;
  }

  const hoje = new Date();
  const dataGeracao = hoje.toLocaleDateString('pt-BR');
  const horaGeracao = hoje.toLocaleTimeString('pt-BR').slice(0,5);

  const itens = (state.data.agenda || [])
    .slice()
    .sort((a,b)=> (a.data||'').localeCompare(b.data||'') || (a.hora||'').localeCompare(b.hora||''));

  const linhas = itens.map(a=>{
    const data = a.dataBr || (a.data ? a.data.split('-').reverse().join('/') : '');
    const hora = a.diaInteiro ? 'Dia inteiro' : (a.inicioHora || a.hora || '');
    const status = (a.status || 'agendado').toUpperCase();
    const valor = money(a.valor || 0, state.cfg.moeda || 'BRL');
    return `
      <tr>
        <td>${data}</td>
        <td>${hora}</td>
        <td>${a.clienteNome || ''}</td>
        <td>${a.servico || ''}</td>
        <td>${status}</td>
        <td style="text-align:right;">${valor}</td>
      </tr>`;
  }).join('');

  const html = `
    <!doctype html>
    <html lang="pt-BR">
    <head>
      <meta charset="utf-8">
      <title>Relatório de Agenda</title>
      <style>
        body {
          font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          padding: 24px;
        }
        h1 { font-size: 20px; margin-bottom: 4px; }
        h2 { font-size: 13px; font-weight: 500; color: #555; margin-top: 0; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 12px; }
        th, td { border: 1px solid #ccc; padding: 6px 8px; }
        th { background:#f5f5f5; text-align: left; }
        tfoot td { font-weight: 600; }
      </style>
    </head>
    <body>
      <h1>Relatório de Agenda</h1>
      <h2>Gerado em ${dataGeracao} às ${horaGeracao}</h2>
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>Hora</th>
            <th>Cliente</th>
            <th>Serviço</th>
            <th>Status</th>
            <th>Valor</th>
          </tr>
        </thead>
        <tbody>
          ${linhas || '<tr><td colspan="6">Nenhum agendamento encontrado.</td></tr>'}
        </tbody>
      </table>
      <script>
        window.onload = function(){
          window.print();
        };
      </script>
    </body>
    </html>
  `;

  win.document.write(html);
  win.document.close();
}

function renderAgendaResumo(){
  const box = $('#agendaResumo');
  if(!box) return;
  const hoje = new Date();
  const mes = hoje.getMonth();
  const ano = hoje.getFullYear();
  let totalMes = 0;
  let conclMes = 0;
  (state.data.agenda||[]).forEach(a=>{
    if(!a.data) return;
    const [yy, mm, dd] = a.data.split('-').map(Number);
    if(!yy || !mm || !dd) return;
    const d = new Date(yy, mm - 1, dd);
    if(d.getMonth()===mes && d.getFullYear()===ano){
      const v = Number(a.valor||0);
      totalMes += v;
      if((a.status||'agendado')==='concluido') conclMes += v;
    }
  });
  box.innerHTML = `
    <div class="kpi">
      <span class="kpi-label">Previsto no mês</span>
      <span class="kpi-value">${money(totalMes, state.cfg.moeda)}</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">Concluído no mês</span>
      <span class="kpi-value">${money(conclMes, state.cfg.moeda)}</span>
    </div>
  `;
}
/* ======= FINANCEIRO ======= */
function openFormTx(tipo){
  $('#formTransacao').classList.remove('hidden');
  $('#txTipo').value = tipo||'receita';
  $('#txData').valueAsDate = new Date();
}
function addTransacao(){
  const obj = {
    id: uid(), tipo: $('#txTipo').value, desc: $('#txDesc').value.trim(),
    valor: parseMoney($('#txValor').value),
    data: $('#txData').value || todayISO(),
    dataBr: formatDateBR($('#txData').value || Date.now()),
    cat: $('#txCat').value,
    createdByUid: getCurrentActorId(),
    ownerId: getDataOwnerId(), createdByName:getCurrentActorName(), createdAt:new Date().toISOString()
  };
  if(!obj.data) return alert('Informe a data.');
  state.data.tx.push(obj);
  auditLog('create','financeiro',obj.id,'Lançamento financeiro criado: '+(obj.desc||obj.cat||''));
  savePerfil();
  $('#formTransacao').classList.add('hidden');
  $('#txDesc').value=''; $('#txValor').value='0,00';
  renderTx();
}
function delTx(id){ const old=state.data.tx.find(t=>t.id===id); auditLog('delete','financeiro',id,'Lançamento excluído: '+((old&&old.desc)||'')); state.data.tx = state.data.tx.filter(t=>t.id!==id); savePerfil(); renderTx(); }
function editTx(id){
  const t = state.data.tx.find(x=>x.id===id); if(!t) return;
  openFormTx(t.tipo);
  $('#txDesc').value=t.desc; $('#txValor').value=t.valor.toFixed(2).replace('.',',');
  $('#txData').value=t.data; $('#txCat').value=t.cat;
  $('#btnAddTx').onclick = ()=>{
    t.tipo=$('#txTipo').value; t.desc=$('#txDesc').value.trim();
    t.valor=parseMoney($('#txValor').value); t.data=$('#txData').value; t.dataBr=formatDateBR(t.data);
    t.cat=$('#txCat').value; t.updatedByUid=getCurrentActorId(); t.updatedByName=getCurrentActorName(); t.updatedAt=new Date().toISOString(); auditLog('update','financeiro',t.id,'Lançamento financeiro atualizado: '+(t.desc||'')); savePerfil(); $('#formTransacao').classList.add('hidden'); renderTx();
    $('#btnAddTx').onclick = addTransacao;
  };
}
function renderTx(){
  const q = ($('#buscaTx').value||'').toLowerCase();
  const box = $('#listaTx'); box.innerHTML='';
  state.data.tx
    .slice().sort((a,b)=>b.data.localeCompare(a.data))
    .filter(t=>!q || (t.tipo+t.desc+t.cat).toLowerCase().includes(q))
    .forEach(t=>{
      const div = document.createElement('div');
      div.className='item dp-tx-item';
      div.innerHTML = `
        <strong>${t.tipo.toUpperCase()} • ${t.dataBr} — ${money(t.valor, state.cfg.moeda)}</strong>
        <div class="muted">${escapeHtml(t.cat||'')} — ${escapeHtml(t.desc||'')}</div>
        <div class="muted" style="font-size:11px">Criado por: ${escapeHtml(t.createdByName||'registro antigo')}</div>
        <div class="row" style="margin-top:6px;gap:8px">
          <button class="btn ghost sm" data-id="${t.id}" data-act="edit"><i class="fa-solid fa-pen"></i> Editar</button>
          <button class="btn danger sm" data-id="${t.id}" data-act="del"><i class="fa-solid fa-trash"></i> Excluir</button>
        </div>`;
      box.appendChild(div);
    });
  $$('#listaTx [data-act="del"]').forEach(b=>b.onclick=()=>delTx(b.dataset.id));
  $$('#listaTx [data-act="edit"]').forEach(b=>b.onclick=()=>editTx(b.dataset.id));
}
function refreshKpis(){
  const totalR = state.data.tx.filter(t=>t.tipo==='receita').reduce((s,t)=>s+t.valor,0);
  const totalD = state.data.tx.filter(t=>t.tipo==='despesa').reduce((s,t)=>s+t.valor,0);
  const saldo = totalR-totalD;
  $('#kpiReceitas').textContent = money(totalR, state.cfg.moeda);
  $('#kpiDespesas').textContent = money(totalD, state.cfg.moeda);
  $('#kpiSaldo').textContent = money(saldo, state.cfg.moeda);
  const topo = $('#saldoTopo');
  if (topo) topo.textContent = money(saldo, state.cfg.moeda);
}

/* ======= FIADOS ======= */
let _fiadoEditId = null;

function ensureFiados(){
  if (!state || !state.data) return;
  if (!Array.isArray(state.data.fiados)) state.data.fiados = [];

  // Migração leve: fiados antigos (sem parcelas) viram 1 parcela
  try{
    (state.data.fiados||[]).forEach(f=>{
      if (!f) return;
      if (!Array.isArray(f.parcelas) || !f.parcelas.length){
        const pago = (f.status||'') === 'pago';
        f.parcelas = [{
          n: 1,
          valor: Number(f.valor||0),
          venc: f.venc || '',
          pago: !!pago,
          pagoData: f.pagoData || '',
          pagoDataBr: f.pagoDataBr || (f.pagoData ? formatDateBR(f.pagoData) : ''),
          txId: f.txId || null
        }];
      }
      // mantém status coerente
      const unpaid = (f.parcelas||[]).filter(p=>!p.pago).reduce((s,p)=>s+Number(p.valor||0),0);
      f.status = unpaid > 0 ? 'aberto' : 'pago';
    });
  }catch(e){ console.warn('Migração fiados/parcelas falhou', e); }
}

function _addDaysISO(iso, days){
  const d = iso ? _parseISODateOnlyLocal(iso) : new Date();
  d.setDate(d.getDate()+days);
  return _dateToISODateOnlyLocal(d);
}
function _addMonthsISO(iso, months){
  const d = iso ? _parseISODateOnlyLocal(iso) : new Date();
  const day = d.getDate();
  d.setMonth(d.getMonth()+months);
  // evita pular mês quando dia não existe
  if (d.getDate() !== day) d.setDate(0);
  return _dateToISODateOnlyLocal(d);
}
function _freqNext(baseISO, i, freq){
  if (freq === 'semanal') return _addDaysISO(baseISO, 7*i);
  if (freq === 'quinzenal') return _addDaysISO(baseISO, 14*i);
  return _addMonthsISO(baseISO, i);
}

function _rebuildParcelasPreview(opts){
  const box = $('#fiParcelasBox');
  if (!box) return;
  const qtd = Math.max(1, Math.min(60, parseInt(opts.qtd||1,10) || 1));
  const total = Number(opts.total||0);
  const firstISO = opts.firstISO || todayISO();
  const freq = opts.freq || 'mensal';

  // divisão do valor (ajusta última parcela para bater certinho)
  const base = qtd > 0 ? Math.floor((total/qtd)*100)/100 : total;
  const parcelas = [];
  let acc = 0;
  for (let i=0;i<qtd;i++){
    let v = base;
    if (i === qtd-1) v = Math.max(0, Math.round((total-acc)*100)/100);
    acc = Math.round((acc+v)*100)/100;
    parcelas.push({
      n: i+1,
      valor: v,
      venc: _freqNext(firstISO, i, freq),
      pago: false,
      pagoData: '',
      pagoDataBr: '',
      txId: null
    });
  }

  // Render UI editável
  box.innerHTML = `
    <div class="muted" style="margin-bottom:8px;">Controle de parcelas (vencimento e data de pagamento).</div>
    <div id="fiParcelasList" class="list" style="gap:10px;"></div>
  `;
  const list = $('#fiParcelasList');
  parcelas.forEach(p=>{
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <strong>Parcela ${p.n}/${qtd} — ${money(p.valor, state.cfg.moeda)}</strong>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center;">
        <div style="flex:1;min-width:160px;">
          <label class="label" style="margin:0 0 6px;opacity:.9;">Vencimento</label>
          <div class="dt-pill flex"><i class="fa-regular fa-calendar"></i><input class="input dt-input" type="date" data-parc="venc" data-n="${p.n}" value="${p.venc||''}"/></div>
        </div>
        <label class="row" style="gap:8px;align-items:center;flex:0 0 auto;margin-top:18px;">
          <input type="checkbox" data-parc="pago" data-n="${p.n}" />
          <span>Pago</span>
        </label>
        <div style="flex:1;min-width:160px;" data-parcwrap="${p.n}" class="hidden">
          <label class="label" style="margin:0 0 6px;opacity:.9;">Data do pagamento</label>
          <div class="dt-pill flex"><i class="fa-regular fa-calendar"></i><input class="input dt-input" type="date" data-parc="pagoData" data-n="${p.n}" value=""/></div>
        </div>
      </div>
    `;
    list.appendChild(div);
  });

  // interações
  $$('#fiParcelasBox [data-parc="pago"]').forEach(chk=>{
    chk.onchange = ()=>{
      const n = chk.dataset.n;
      const wrap = $(`#fiParcelasBox [data-parcwrap="${n}"]`);
      if (!wrap) return;
      if (chk.checked){
        wrap.classList.remove('hidden');
        const inp = wrap.querySelector('[data-parc="pagoData"]');
        if (inp && !inp.value) inp.value = todayISO();
      } else {
        wrap.classList.add('hidden');
      }
    };
  });
}

function _renderParcelasFromFiado(f){
  const box = $('#fiParcelasBox');
  if (!box) return;
  const parcelas = Array.isArray(f.parcelas) ? f.parcelas : [];
  const qtd = parcelas.length || 1;
  box.innerHTML = `
    <div class="muted" style="margin-bottom:8px;">Controle de parcelas (vencimento e data de pagamento).</div>
    <div id="fiParcelasList" class="list" style="gap:10px;"></div>
  `;
  const list = $('#fiParcelasList');

  parcelas.forEach(p=>{
    const div = document.createElement('div');
    div.className = 'item';
    const pagoLbl = p.pago ? ` • Pago: ${(p.pagoDataBr || (p.pagoData ? formatDateBR(p.pagoData) : ''))}` : '';
    div.innerHTML = `
      <strong>Parcela ${p.n||1}/${qtd} — ${money(Number(p.valor||0), state.cfg.moeda)}${pagoLbl}</strong>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center;">
        <div style="flex:1;min-width:160px;">
          <label class="label" style="margin:0 0 6px;opacity:.9;">Vencimento</label>
          <div class="dt-pill flex"><i class="fa-regular fa-calendar"></i><input class="input dt-input" type="date" data-parc="venc" data-n="${p.n}" value="${p.venc||''}"/></div>
        </div>
        <label class="row" style="gap:8px;align-items:center;flex:0 0 auto;margin-top:18px;">
          <input type="checkbox" data-parc="pago" data-n="${p.n}" ${p.pago ? 'checked' : ''} />
          <span>Pago</span>
        </label>
        <div style="flex:1;min-width:160px;" data-parcwrap="${p.n}" class="${p.pago ? '' : 'hidden'}">
          <label class="label" style="margin:0 0 6px;opacity:.9;">Data do pagamento</label>
          <div class="dt-pill flex"><i class="fa-regular fa-calendar"></i><input class="input dt-input" type="date" data-parc="pagoData" data-n="${p.n}" value="${p.pagoData||''}"/></div>
        </div>
      </div>
      ${p.txId ? `<div class="muted" style="margin-top:6px;">Lançado no Financeiro ✅</div>` : ''}
    `;
    list.appendChild(div);
  });

  // interações
  $$('#fiParcelasBox [data-parc="pago"]').forEach(chk=>{
    chk.onchange = ()=>{
      const n = chk.dataset.n;
      const wrap = $(`#fiParcelasBox [data-parcwrap="${n}"]`);
      if (!wrap) return;
      if (chk.checked){
        wrap.classList.remove('hidden');
        const inp = wrap.querySelector('[data-parc="pagoData"]');
        if (inp && !inp.value) inp.value = todayISO();
      } else {
        wrap.classList.add('hidden');
      }
    };
  });
}

function openFormFiado(editId=null){
  ensureFiados();
  _fiadoEditId = editId;
  const form = $('#formFiado');
  if (!form) return;

  // popula clientes
  const sel = $('#fiCliente');
  if (sel){
    sel.innerHTML = '';
    (state.data.clientes||[]).slice().sort((a,b)=>(a.nome||'').localeCompare(b.nome||'')).forEach(c=>{
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.nome;
      sel.appendChild(o);
    });
  }

  // defaults
  $('#fiadoFormTitle').textContent = editId ? 'Editar Fiado' : 'Novo Fiado';
  $('#fiDesc').value = '';
  $('#fiValor').value = '0,00';
  if ($('#fiParcQtd')) $('#fiParcQtd').value = '1';
  if ($('#fiParcPrimeira')) $('#fiParcPrimeira').value = todayISO();
  if ($('#fiParcFreq')) $('#fiParcFreq').value = 'mensal';
  $('#fiData').value = todayISO();
  $('#fiVenc').value = '';

  if (editId){
    const f = state.data.fiados.find(x=>x.id===editId);
    if (f){
      if (sel) sel.value = f.clienteId || (sel.options[0]?.value || '');
      $('#fiDesc').value = f.desc || '';
      $('#fiValor').value = Number(f.valor||0).toFixed(2).replace('.',',');
      // parcelas
      const parcelas = Array.isArray(f.parcelas) ? f.parcelas : [];
      const qtd = parcelas.length || 1;
      if ($('#fiParcQtd')) $('#fiParcQtd').value = String(qtd);
      if ($('#fiParcPrimeira')) $('#fiParcPrimeira').value = (parcelas[0]?.venc) || (f.venc || f.data || todayISO());
      if ($('#fiParcFreq')) $('#fiParcFreq').value = (f.parcFreq || 'mensal');

      $('#fiData').value = f.data || todayISO();
      $('#fiVenc').value = f.venc || '';

      // Se já tem parcelas pagas, não deixa recriar/redistribuir
      const hasPaid = (parcelas||[]).some(p=>p && p.pago);
      if ($('#fiValor')) $('#fiValor').disabled = !!hasPaid;
      if ($('#fiParcQtd')) $('#fiParcQtd').disabled = !!hasPaid;
      if ($('#fiParcPrimeira')) $('#fiParcPrimeira').disabled = !!hasPaid;
      if ($('#fiParcFreq')) $('#fiParcFreq').disabled = !!hasPaid;

      _renderParcelasFromFiado(f);
    }
  } else {
    // Novo: monta preview automático
    if ($('#fiValor')) $('#fiValor').disabled = false;
    if ($('#fiParcQtd')) $('#fiParcQtd').disabled = false;
    if ($('#fiParcPrimeira')) $('#fiParcPrimeira').disabled = false;
    if ($('#fiParcFreq')) $('#fiParcFreq').disabled = false;
    _rebuildParcelasPreview({
      qtd: $('#fiParcQtd')?.value,
      total: parseMoney($('#fiValor')?.value || '0'),
      firstISO: $('#fiParcPrimeira')?.value || todayISO(),
      freq: $('#fiParcFreq')?.value || 'mensal'
    });
  }

  // listeners (apenas quando pode recalcular)
  const canRecalc = !editId;
  if (canRecalc){
    const rebuild = ()=>{
      _rebuildParcelasPreview({
        qtd: $('#fiParcQtd')?.value,
        total: parseMoney($('#fiValor')?.value || '0'),
        firstISO: $('#fiParcPrimeira')?.value || todayISO(),
        freq: $('#fiParcFreq')?.value || 'mensal'
      });
    };
    if ($('#fiValor')) $('#fiValor').oninput = rebuild;
    if ($('#fiParcQtd')) $('#fiParcQtd').oninput = rebuild;
    if ($('#fiParcPrimeira')) $('#fiParcPrimeira').onchange = rebuild;
    if ($('#fiParcFreq')) $('#fiParcFreq').onchange = rebuild;
  }

  form.classList.remove('hidden');
}

function closeFormFiado(){
  _fiadoEditId = null;
  const form = $('#formFiado');
  if (form) form.classList.add('hidden');
}

function salvarFiado(){
  ensureFiados();
  const clienteId = $('#fiCliente').value;
  const cliente = (state.data.clientes||[]).find(c=>c.id===clienteId);
  if (!clienteId || !cliente) return alert('Selecione um cliente.');

  const data = $('#fiData').value || todayISO();
  const valor = parseMoney($('#fiValor').value);
  if (!valor || valor <= 0) return alert('Informe um valor válido.');

  const payload = {
    id: _fiadoEditId || uid(),
    clienteId,
    clienteNome: cliente.nome,
    desc: ($('#fiDesc').value||'').trim(),
    valor,
    data,
    dataBr: formatDateBR(data),
    venc: $('#fiVenc').value || '',
    status: 'aberto',
    criadoEm: new Date().toISOString(),
    atualizadoEm: new Date().toISOString()
  };

  // Parcelas (lê do formulário)
  const qtd = Math.max(1, Math.min(60, parseInt($('#fiParcQtd')?.value || '1',10) || 1));
  payload.parcFreq = $('#fiParcFreq')?.value || 'mensal';
  payload.parcelas = [];

  // Se o box foi montado como preview, os inputs estão dentro de #fiParcelasBox
  // Para editar, também.
  for (let i=1;i<=qtd;i++){
    const venc = $(`#fiParcelasBox [data-parc="venc"][data-n="${i}"]`)?.value || '';
    const pago = !!($(`#fiParcelasBox [data-parc="pago"][data-n="${i}"]`)?.checked);
    const pagoData = $(`#fiParcelasBox [data-parc="pagoData"][data-n="${i}"]`)?.value || '';
    payload.parcelas.push({
      n: i,
      valor: 0, // será preenchido abaixo
      venc,
      pago,
      pagoData: pago ? (pagoData || todayISO()) : '',
      pagoDataBr: pago ? formatDateBR((pagoData||todayISO())) : '',
      txId: null
    });
  }

  // Define valor por parcela: tenta manter o que já existia ao editar
  // Se editar e já tinha parcelas, mantém os valores originais (para não bagunçar histórico)
  if (_fiadoEditId){
    const old = state.data.fiados.find(x=>x.id===_fiadoEditId);
    if (old && Array.isArray(old.parcelas) && old.parcelas.length === payload.parcelas.length){
      payload.parcelas.forEach((p,idx)=>{
        p.valor = Number(old.parcelas[idx]?.valor||0);
        p.txId = old.parcelas[idx]?.txId || null;
      });
    }
  }

  // Se não conseguiu manter valores (novo fiado ou tamanho diferente), distribui o total
  if (payload.parcelas.some(p=>!p.valor)){
    const base = qtd > 0 ? Math.floor((valor/qtd)*100)/100 : valor;
    let acc = 0;
    payload.parcelas.forEach((p,idx)=>{
      let v = base;
      if (idx === qtd-1) v = Math.max(0, Math.round((valor-acc)*100)/100);
      acc = Math.round((acc+v)*100)/100;
      p.valor = v;
    });
  }

  // Atualiza status conforme parcelas
  const unpaidSum = payload.parcelas.filter(p=>!p.pago).reduce((s,p)=>s+Number(p.valor||0),0);
  payload.status = unpaidSum > 0 ? 'aberto' : 'pago';

  // Ao marcar parcela como PAGA, lança automaticamente no Financeiro (1 receita por parcela).
  // Ao desmarcar (voltar para em aberto), remove o lançamento correspondente.
  // Também funciona no cadastro de um novo fiado (se alguma parcela já for marcada como paga).
  try{
    if (!Array.isArray(state.data.tx)) state.data.tx = [];

    const old = _fiadoEditId ? state.data.fiados.find(x=>x.id===_fiadoEditId) : null;
    const oldParcelas = (old && Array.isArray(old.parcelas)) ? old.parcelas : [];

    payload.parcelas.forEach((p,idx)=>{
      const oldP = oldParcelas[idx] || {};

      const eraPago = !!oldP.pago;
      const virouPago = !!p.pago && !eraPago;
      const virouAberto = !p.pago && eraPago;

      // garante datas BR
      if (p.pago){
        const dISO = p.pagoData || todayISO();
        p.pagoData = dISO;
        p.pagoDataBr = formatDateBR(dISO);
      } else {
        p.pagoData = '';
        p.pagoDataBr = '';
      }

      // remove receita se voltou para aberto
      const existingTxId = oldP.txId || p.txId || null;
      if (virouAberto && existingTxId){
        state.data.tx = (state.data.tx||[]).filter(t=>t && t.id !== existingTxId);
        p.txId = null;
        return;
      }

      // cria receita se virou pago e ainda não existe
      if (virouPago && !existingTxId){
        const txId = uid();
        const dataISO = p.pagoData || todayISO();
        const tx = {
          id: txId,
          tipo: 'receita',
          desc: `Fiado recebido • ${cliente.nome} • Parcela ${p.n}/${qtd}${payload.desc ? ' • ' + payload.desc : ''}`,
          valor: Number(p.valor||0),
          data: dataISO,
          dataBr: formatDateBR(dataISO),
          cat: 'Fiados',
          origem: 'fiado_parcela',
          origemId: payload.id,
          origemParcela: p.n
        };
        state.data.tx.push(tx);
        p.txId = txId;
        return;
      }

      // se continua pago e já existe, mantém e atualiza o lançamento para ficar consistente
      if (p.pago && existingTxId){
        p.txId = existingTxId;
        const t = (state.data.tx||[]).find(x=>x && x.id===existingTxId);
        if (t){
          t.tipo = 'receita';
          t.cat = 'Fiados';
          t.origem = 'fiado_parcela';
          t.origemId = payload.id;
          t.origemParcela = p.n;
          t.valor = Number(p.valor||0);
          t.data = p.pagoData || t.data || todayISO();
          t.dataBr = formatDateBR(t.data);
          t.desc = `Fiado recebido • ${cliente.nome} • Parcela ${p.n}/${qtd}${payload.desc ? ' • ' + payload.desc : ''}`;
        }
      } else {
        // mantém txId antigo (se houver)
        p.txId = existingTxId;
      }
    });
  } catch(e){
    console.warn('Falha ao sincronizar parcelas do fiado com Financeiro', e);
  }

  if (_fiadoEditId){
    const f = state.data.fiados.find(x=>x.id===_fiadoEditId);
    if (!f) return alert('Fiado não encontrado.');
    if (f.status === 'pago') return alert('Este fiado já está pago e não pode ser editado.');
    Object.assign(f, payload);
  } else {
    state.data.fiados.push(payload);
  }

  savePerfil();
  closeFormFiado();
  renderFiados();
  refreshSystemStats();
}

function delFiado(id){
  ensureFiados();
  const f = state.data.fiados.find(x=>x.id===id);
  if (!f) return;
  const parcelas = Array.isArray(f.parcelas) ? f.parcelas : [];
  const temLancamentos = parcelas.some(p=>p && p.txId) || (state.data.tx||[]).some(t=>t && t.origem==='fiado_parcela' && t.origemId===f.id);
  const msg = (f.status === 'pago')
    ? `Excluir este fiado PAGO?${temLancamentos ? '\n\nObs.: as receitas lançadas deste fiado também serão removidas.' : ''}`
    : `Excluir este fiado?${temLancamentos ? '\n\nObs.: as receitas lançadas deste fiado também serão removidas.' : ''}`;
  if(!confirm(msg)) return;

  // Remove lançamentos vinculados (por segurança, usa txId das parcelas e também origemId)
  try{
    const txIds = new Set((parcelas||[]).map(p=>p && p.txId).filter(Boolean));
    state.data.tx = (state.data.tx||[]).filter(t=>{
      if (!t) return false;
      if (txIds.has(t.id)) return false;
      if (t.origem === 'fiado_parcela' && t.origemId === f.id) return false;
      return true;
    });
  }catch(e){
    console.warn('Falha ao remover lançamentos do fiado', e);
  }

  state.data.fiados = state.data.fiados.filter(x=>x.id!==id);
  savePerfil();
  renderFiados();
  renderTx();
  refreshKpis();
  refreshSystemStats();
}

function receberFiado(id){
  ensureFiados();
  const f = state.data.fiados.find(x=>x.id===id);
  if (!f) return;
  if ((f.status||'aberto') === 'pago') return;

  // recebe por parcela (se existir)
  const parcelas = Array.isArray(f.parcelas) ? f.parcelas : [];
  if (!parcelas.length){
    // fallback: cria 1 parcela
    f.parcelas = [{ n:1, valor:Number(f.valor||0), venc:f.venc||'', pago:false, pagoData:'', pagoDataBr:'', txId:null }];
  }

  const ab = (f.parcelas||[]).filter(p=>!p.pago);
  if (!ab.length){
    f.status = 'pago';
    savePerfil();
    renderFiados();
    refreshSystemStats();
    return;
  }

  let alvo = ab[0];
  if (ab.length > 1){
    const msg = `Qual parcela deseja receber?\n\nEm aberto: ${ab.map(p=>p.n).join(', ')}\n\nDigite o número da parcela:`;
    const resp = prompt(msg, String(ab[0].n||1));
    const n = parseInt((resp||'').trim(),10);
    const found = ab.find(p=>Number(p.n)===Number(n));
    if (!found) return;
    alvo = found;
  }

  if(!confirm(`Receber Parcela ${alvo.n}/${(f.parcelas||[]).length} e lançar como RECEITA no Financeiro?`)) return;

  const dataISO = todayISO();
  alvo.pago = true;
  alvo.pagoData = dataISO;
  alvo.pagoDataBr = formatDateBR(dataISO);

  // cria receita (se ainda não existe)
  if (!alvo.txId){
    const txId = uid();
    const tx = {
      id: txId,
      tipo: 'receita',
      desc: `Fiado recebido • ${f.clienteNome} • Parcela ${alvo.n}/${(f.parcelas||[]).length}${f.desc ? ' • ' + f.desc : ''}`,
      valor: Number(alvo.valor||0),
      data: dataISO,
      dataBr: formatDateBR(dataISO),
      cat: 'Fiados',
      origem: 'fiado_parcela',
      origemId: f.id,
      origemParcela: alvo.n
    };
    state.data.tx.push(tx);
    alvo.txId = txId;
  }

  const unpaid = (f.parcelas||[]).filter(p=>!p.pago).reduce((s,p)=>s+Number(p.valor||0),0);
  f.status = unpaid > 0 ? 'aberto' : 'pago';
  if (f.status === 'pago'){
    f.pagoEm = new Date().toISOString();
    f.pagoData = dataISO;
    f.pagoDataBr = formatDateBR(dataISO);
  }
  f.atualizadoEm = new Date().toISOString();

  savePerfil();
  renderFiados();
  renderTx();
  refreshKpis();
  refreshSystemStats();
}

function renderFiados(){
  ensureFiados();
  const q = ($('#buscaFiado')?.value || '').toLowerCase();
  const box = $('#listaFiados');
  if (!box) return;
  box.innerHTML = '';

  const arr = (state.data.fiados||[])
    .slice()
    .sort((a,b)=>{
      // abertos primeiro, depois por data desc
      const sa = (a.status||'aberto');
      const sb = (b.status||'aberto');
      if (sa !== sb) return sa === 'aberto' ? -1 : 1;
      return String(b.data||'').localeCompare(String(a.data||''));
    })
    .filter(f=>{
      const blob = `${f.clienteNome||''} ${f.desc||''} ${f.status||''}`.toLowerCase();
      return !q || blob.includes(q);
    });

  if (!arr.length){
    box.innerHTML = '<p class="muted">Nenhum fiado encontrado.</p>';
    return;
  }

  arr.forEach(f=>{
    const div = document.createElement('div');
    div.className = 'item';

    const status = (f.status||'aberto');
    const parcelas = Array.isArray(f.parcelas) ? f.parcelas : [];
    const qtdP = parcelas.length || 1;
    const pagos = parcelas.filter(p=>p && p.pago).length;
    const aberto = parcelas.filter(p=>p && !p.pago).reduce((s,p)=>s+Number(p.valor||0),0);
    const proxVenc = parcelas.filter(p=>p && !p.pago && p.venc).map(p=>p.venc).sort()[0] || (f.venc||'');
    const vencLabel = proxVenc ? ` • Próx. venc: ${formatDateBR(proxVenc)}` : '';
    const pagoLabel = status==='pago' ? ` • Pago: ${(f.pagoDataBr || (f.pagoData ? formatDateBR(f.pagoData) : ''))}` : '';

    div.innerHTML = `
      <strong>${status.toUpperCase()} • ${f.dataBr || (f.data ? formatDateBR(f.data) : '')} — ${money(f.valor, state.cfg.moeda)}</strong>
      <div class="muted">Cliente: ${escapeHtml(f.clienteNome || '')}${escapeHtml(vencLabel)}${escapeHtml(pagoLabel)}</div>
      <div class="muted">Parcelas: ${pagos}/${qtdP} • Em aberto: ${money(aberto, state.cfg.moeda)}</div>
      ${f.desc ? `<div class="muted">${escapeHtml(f.desc)}</div>` : ''}
      <div class="row" style="margin-top:6px;gap:8px;flex-wrap:wrap">
        ${status==='aberto' ? `<button class="btn success sm" data-id="${f.id}" data-act="pay"><i class="fa-solid fa-circle-check"></i> Receber</button>` : ''}
        ${status==='aberto' ? `<button class="btn ghost sm" data-id="${f.id}" data-act="edit"><i class="fa-solid fa-pen"></i> Editar</button>` : ''}
        <button class="btn danger sm" data-id="${f.id}" data-act="del"><i class="fa-solid fa-trash"></i> Excluir</button>
      </div>
    `;
    box.appendChild(div);
  });

  $$('#listaFiados [data-act="pay"]').forEach(b=>b.onclick=()=>receberFiado(b.dataset.id));
  $$('#listaFiados [data-act="edit"]').forEach(b=>b.onclick=()=>openFormFiado(b.dataset.id));
  $$('#listaFiados [data-act="del"]').forEach(b=>b.onclick=()=>delFiado(b.dataset.id));
}

/* ======= CLIENTES ======= */
function addCliente(){
  const nome = $('#clNome').value.trim();
  if (!nome) {
    alert('Informe o nome.');
    return;
  }
  const obj = {
    id: uid(),
    nome,
    email: $('#clEmail').value.trim(),
    zap: $('#clZap').value.trim(),
    nasc: ($('#clNasc') ? $('#clNasc').value : ''),
    end: $('#clEnd').value.trim()
  };
  state.data.clientes.push(obj);
  savePerfil();
  $('#clNome').value=''; $('#clEmail').value=''; $('#clZap').value=''; if ($('#clNasc')) $('#clNasc').value=''; $('#clEnd').value='';
  if (typeof voltarListaClientes === 'function') voltarListaClientes();
  renderClientes();
}


function delCliente(id){
  if(!confirm('Excluir cliente?')) return;
  state.data.clientes = state.data.clientes.filter(c=>c.id!==id);
  state.data.agenda = state.data.agenda.filter(a=>a.clienteId!==id);
  state.data.an = state.data.an.filter(a=>a.clienteId!==id);
  savePerfil(); refreshAll();
}
function editCliente(id){
  const c = state.data.clientes.find(x=>x.id===id); if(!c) return;

  if (typeof abrirCadastroCliente === 'function') abrirCadastroCliente();

  $('#clNome').value=c.nome; $('#clEmail').value=c.email; $('#clZap').value=c.zap;
  if ($('#clNasc')) $('#clNasc').value = (c.nasc || '');
  $('#clEnd').value=c.end;
  $('#btnAddCliente').textContent='Salvar Alterações';

  const originalOnClick = $('#btnAddCliente').onclick;

  $('#btnAddCliente').onclick = ()=>{
    c.nome=$('#clNome').value.trim(); c.email=$('#clEmail').value.trim();
    c.zap=$('#clZap').value.trim(); c.end=$('#clEnd').value.trim();
    if ($('#clNasc')) c.nasc = $('#clNasc').value;
    savePerfil(); renderClientes(); 
    if (typeof voltarListaClientes === 'function') voltarListaClientes();

    $('#btnAddCliente').textContent='Cadastrar Cliente';
    $('#btnAddCliente').onclick = originalOnClick;

    $('#clNome').value=''; $('#clEmail').value=''; $('#clZap').value=''; if ($('#clNasc')) $('#clNasc').value=''; $('#clEnd').value='';
  };
}

function renderClientes(){
  const q = ($('#buscaCliente').value||'').toLowerCase();
  const box = $('#listaClientes'); box.innerHTML='';
  state.data.clientes
    .filter(c=>!q || c.nome.toLowerCase().includes(q))
    .forEach(c=>{
      const div = document.createElement('div');
      div.className='item dp-cliente-card';
      const nomeSeguro = escapeHtml(c.nome||'');
      const inicial = escapeHtml(String(c.nome||'?').trim().charAt(0).toUpperCase() || '?');
      div.innerHTML = `
        <div class="dp-cliente-main">
          <div class="dp-avatar" aria-hidden="true">${inicial}</div>
          <div class="dp-cliente-copy"><strong>${nomeSeguro}</strong>
        <div class="muted">${escapeHtml(c.email||'—')} • ${escapeHtml(c.zap||'—')}</div>
        <div class="muted sm">${c.nasc ? ('Nascimento: ' + formatDateBR(c.nasc) + ' • ') : ''}${escapeHtml(c.end||' ')}</div></div>
          <span class="dp-card-chevron" aria-hidden="true">›</span>
        </div>
        <div class="row dp-card-actions" style="gap:8px;margin-top:6px">
          <button class="btn ghost sm" data-id="${c.id}" data-act="edit"><i class="fa-solid fa-pen"></i> Editar</button>
          <button class="btn danger sm" data-id="${c.id}" data-act="del"><i class="fa-solid fa-trash"></i> Excluir</button>
        </div>`;
      box.appendChild(div);
    });
  $$('#listaClientes [data-act="del"]').forEach(b=>b.onclick=()=>delCliente(b.dataset.id));
  $$('#listaClientes [data-act="edit"]').forEach(b=>b.onclick=()=>editCliente(b.dataset.id));
  renderSelClientes('#agCliente'); renderSelClientes('#anCliente');
}
function renderSelClientes(selector){
  const sel = $(selector); sel.innerHTML = '<option value="">Selecione um cliente</option>';
  state.data.clientes.forEach(c=>{ const o=document.createElement('option'); o.value=c.id; o.textContent=c.nome; sel.appendChild(o); });

  // Atualiza o botão/seletor visual do Novo Agendamento
  if (selector === '#agCliente') {
    try { syncAgClientePicker(); } catch(e) {}
  }
}

// Mantém o texto do botão “Cliente” em sincronia com o select escondido
function syncAgClientePicker(){
  const sel = document.getElementById('agCliente');
  const txt = document.getElementById('agClientePickerText');
  if(!sel || !txt) return;
  const opt = sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
  const label = (opt && opt.value) ? (opt.textContent || 'Selecione um cliente') : 'Selecione um cliente';
  txt.textContent = label;
}

// ===== Busca de Cliente no Novo Agendamento (lupa no seletor) =====
function openModalBuscaClienteAg(){
  const modal = document.getElementById('modalBuscaClienteAg');
  if(!modal) return;
  modal.classList.remove('hidden');
  const inp = document.getElementById('agClienteBuscaInput');
  if(inp){
    inp.value = '';
    renderBuscaClienteAgLista('');
    setTimeout(()=>{ try { inp.focus(); } catch(e){} }, 50);
  } else {
    renderBuscaClienteAgLista('');
  }
}

function closeModalBuscaClienteAg(){
  const modal = document.getElementById('modalBuscaClienteAg');
  if(!modal) return;
  modal.classList.add('hidden');
}

function renderBuscaClienteAgLista(query){
  const box = document.getElementById('agClienteBuscaLista');
  if(!box) return;
  const q = (query||'').trim().toLowerCase();

  const clientes = (state.data && state.data.clientes) ? state.data.clientes : [];
  const filtered = !q ? clientes : clientes.filter(c=>{
    const nome = (c.nome||'').toLowerCase();
    const zap  = (c.zap||'').toLowerCase();
    const email= (c.email||'').toLowerCase();
    return nome.includes(q) || zap.includes(q) || email.includes(q);
  });

  box.innerHTML = '';
  if(filtered.length === 0){
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'Nenhum cliente encontrado.';
    box.appendChild(empty);
    return;
  }

  filtered.forEach(c=>{
    const div = document.createElement('div');
    div.className = 'client-search-item';
    div.innerHTML = `
      <strong>${escapeHtml(c.nome||'Sem nome')}</strong>
      <div class="muted">${escapeHtml(c.email||'—')} • ${escapeHtml(c.zap||'—')}</div>
    `;
    div.onclick = ()=>{
      const sel = document.getElementById('agCliente');
      if(sel){
        sel.value = c.id;
        try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch(e){}
      }
      closeModalBuscaClienteAg();
    };
    box.appendChild(div);
  });
}

// ===== Busca de Serviço no Novo Agendamento =====
function openModalBuscaServicoAg(){
  const modal = document.getElementById('modalBuscaServicoAg');
  if(!modal) return;
  modal.classList.remove('hidden');
  const inp = document.getElementById('agServicoBuscaInput');
  if(inp){
    inp.value = '';
    renderBuscaServicoAgLista('');
    setTimeout(()=>{ try { inp.focus(); } catch(e){} }, 50);
  } else {
    renderBuscaServicoAgLista('');
  }
}

function closeModalBuscaServicoAg(){
  const modal = document.getElementById('modalBuscaServicoAg');
  if(!modal) return;
  modal.classList.add('hidden');
}

function renderBuscaServicoAgLista(query){
  const box = document.getElementById('agServicoBuscaLista');
  if(!box) return;
  const q = (query||'').trim().toLowerCase();

  const servicos = (state.data && state.data.servicos) ? state.data.servicos : [];
  const filtered = !q ? servicos : servicos.filter(s=>{
    const nome = (s.nome||'').toLowerCase();
    const desc = (s.descricao||'').toLowerCase();
    return nome.includes(q) || desc.includes(q);
  });

  box.innerHTML = '';
  if(filtered.length === 0){
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'Nenhum serviço encontrado.';
    box.appendChild(empty);
    return;
  }

  filtered.forEach(s=>{
    const div = document.createElement('div');
    div.className = 'client-search-item';
    div.innerHTML = `
      <strong>${escapeHtml(s.nome||'Sem nome')}</strong>
      <div class="muted">${escapeHtml(s.descricao||'—')}${(typeof s.preco === 'number') ? ` • ${money(s.preco, state.cfg.moeda)}` : ''}</div>
    `;
    div.onclick = ()=>{
      const sel = document.getElementById('agServicoSel');
      if(sel){
        sel.value = s.id;
        try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch(e){}
      }
      closeModalBuscaServicoAg();
    };
    box.appendChild(div);
  });
}

/* ======= SERVIÇOS ======= */
function addServico(){

  const nome = $('#svNome').value.trim();
  if(!nome) return alert('Informe o nome do serviço.');
  const obj = { 
    id: uid(), 
    nome, 
    descricao: $('#svDescricao').value.trim(), 
    preco: parseMoney($('#svPreco').value),
    duracaoMin: parseInt($('#svDuracao').value||'0',10)||0
  };
  state.data.servicos.push(obj);
  savePerfil();
  $('#svNome').value=''; $('#svDescricao').value=''; $('#svPreco').value='0,00'; $('#svDuracao').value='';
  renderServicos();
  if (typeof voltarListaServicos === 'function') voltarListaServicos();
}
function delServico(id){
  if(!confirm('Excluir serviço?')) return;
  state.data.servicos = state.data.servicos.filter(s=>s.id!==id);
  savePerfil(); renderServicos();
}



function abrirCadastroCliente(){
  const cadastroTab = document.getElementById('tab-clientes-cadastro');
  const listaTab = document.getElementById('tab-clientes');
  if (listaTab) listaTab.classList.remove('show');
  if (cadastroTab) cadastroTab.classList.add('show');
}

function voltarListaClientes(){
  const cadastroTab = document.getElementById('tab-clientes-cadastro');
  const listaTab = document.getElementById('tab-clientes');
  if (cadastroTab) cadastroTab.classList.remove('show');
  if (listaTab) listaTab.classList.add('show');
}

function abrirCadastroServico(){
  const cadastroTab = document.getElementById('tab-servicos-cadastro');
  const listaTab = document.getElementById('tab-servicos');
  if (listaTab) listaTab.classList.remove('show');
  if (cadastroTab) cadastroTab.classList.add('show');
}

function voltarListaServicos(){
  const cadastroTab = document.getElementById('tab-servicos-cadastro');
  const listaTab = document.getElementById('tab-servicos');
  if (cadastroTab) cadastroTab.classList.remove('show');
  if (listaTab) listaTab.classList.add('show');
}

function editServico(id){
  const s = state.data.servicos.find(x=>x.id===id); if(!s) return;

  if (typeof abrirCadastroServico === 'function') abrirCadastroServico();

  $('#svNome').value=s.nome; $('#svDescricao').value=s.descricao; $('#svPreco').value=s.preco.toFixed(2).replace('.',',');
  $('#svDuracao').value = s.duracaoMin || '';
  $('#btnAddServico').textContent='Salvar Alterações';

  // Salva a função original para restaurar depois
  const originalOnClick = $('#btnAddServico').onclick;

  $('#btnAddServico').onclick = ()=>{
    s.nome=$('#svNome').value.trim(); s.descricao=$('#svDescricao').value.trim();
    s.preco=parseMoney($('#svPreco').value);
    s.duracaoMin = parseInt($('#svDuracao').value||'0',10)||0;
    savePerfil(); renderServicos(); 
    if (typeof voltarListaServicos === 'function') voltarListaServicos();

    // Restaura o botão para a função de cadastro
    $('#btnAddServico').textContent='Cadastrar Serviço';
    $('#btnAddServico').onclick = originalOnClick; // Restaura a função original (addServico)

    // Limpa o formulário
    $('#svNome').value=''; $('#svDescricao').value=''; $('#svPreco').value='0,00'; $('#svDuracao').value='';
  };
}
function renderServicos(){
  const q = ($('#buscaServico').value||'').toLowerCase();
  const box = $('#listaServicos'); box.innerHTML='';
  state.data.servicos
    .filter(s=>!q || (s.nome+s.descricao).toLowerCase().includes(q))
    .forEach(s=>{
      const div = document.createElement('div');
      div.className='item dp-servico-card';
      div.innerHTML = `
        <div class="row dp-servico-main" style="justify-content:space-between;align-items:center;gap:12px;">
          <div class="dp-service-icon" aria-hidden="true"><i class="fa-solid fa-scissors"></i></div>
          <div class="flex1 dp-servico-copy">
            <strong>${escapeHtml(s.nome||'')}</strong>
            <div class="muted">
              <strong>Preço:</strong> ${money(s.preco, state.cfg.moeda)}&nbsp;•&nbsp;
              <strong>Duração:</strong> ${(s.duracaoMin || 0)} min
            </div>
          </div>
          <div class="row" style="gap:8px;">
            <button class="btn ghost sm" data-id="${s.id}" data-act="edit"><i class="fa-solid fa-pen"></i> Editar</button>
            <button class="btn danger sm" data-id="${s.id}" data-act="del"><i class="fa-solid fa-trash"></i> Excluir</button>
          </div>
        </div>`;
      box.appendChild(div);
    });
  $$('#listaServicos [data-act="del"]').forEach(b=>b.onclick=()=>delServico(b.dataset.id));
  $$('#listaServicos [data-act="edit"]').forEach(b=>b.onclick=()=>editServico(b.dataset.id));
  renderSelServicos('#agServicoSel');
}
function renderSelServicos(selector){
  const sel = $(selector); sel.innerHTML = '<option value="">Selecione um serviço</option>';
  state.data.servicos.forEach(s=>{ const o=document.createElement('option'); o.value=s.id; o.textContent=s.nome; sel.appendChild(o); });

  // Atualiza o botão/seletor visual do Novo Agendamento
  if (selector === '#agServicoSel') {
    try { syncAgServicoSelPicker(); } catch(e) {}
  }
}

// Mantém o texto do botão “Serviço Cadastrado” em sincronia com o select escondido
function syncAgServicoSelPicker(){
  const sel = document.getElementById('agServicoSel');
  const txt = document.getElementById('agServicoSelPickerText');
  if(!sel || !txt) return;
  const opt = sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
  const label = (opt && opt.value) ? (opt.textContent || 'Selecione um serviço') : 'Selecione um serviço';
  txt.textContent = label;
}
function preencherValorServico(){
  // Atualiza label do botão visual
  try { syncAgServicoSelPicker(); } catch(e) {}
  const sid = $('#agServicoSel').value;
  if(!sid) return;
  const servico = state.data.servicos.find(s=>s.id===sid);
  if(servico){
    $('#agServico').value = servico.nome;
    $('#agValor').value = servico.preco.toFixed(2).replace('.',',');
    // Se houver duração padrão, preenche hora final automaticamente
    if (servico.duracaoMin && $('#agInicioHora') && $('#agFimHora')) {
      const h = $('#agInicioHora').value;
      if (h) {
        const [hh,mm] = h.split(':').map(Number);
        const total = hh*60 + (mm||0) + Number(servico.duracaoMin||0);
        const hh2 = Math.floor((total % (24*60)) / 60);
        const mm2 = total % 60;
        const pad = (n)=>String(n).padStart(2,'0');
        $('#agFimHora').value = pad(hh2)+':'+pad(mm2);
      }
    }
  }
}

/* ======= ANAMNESE ======= */
// Estrutura das perguntas: {p: 'Pergunta', t: 'texto'|'assinalar'|'selecionar', opt?: ['A','B']}
const MODELOS_PADRAO = {
  basico: {
    perguntas: [
      {p:'Alergia a medicamentos?', t:'texto'},
      {p:'Doenças pré-existentes?', t:'texto'},
      {p:'Uso de anticoagulantes?', t:'texto'},
      {p:'Cicatrização lenta?', t:'texto'},
      {p:'Já fez tatuagem antes?', t:'texto'}
    ],
    termos: 'Declaro que as informações prestadas são verdadeiras e autorizo a realização do procedimento.'
  },
  detalhado: {
    perguntas: [
      {p:'Altura', t:'texto'},
      {p:'Peso', t:'texto'},
      {p:'IMC (aprox.)', t:'texto'},
      {p:'Pressão recente', t:'texto'},
      {p:'Cirurgias', t:'texto'},
      {p:'Cicatriz/Queloide', t:'texto'},
      {p:'Tendência a sangramento', t:'texto'},
      {p:'Avaliação da pele', t:'texto'},
      {p:'Consentimento informado', t:'assinalar'}
    ],
    termos: 'Li e concordo com os termos, riscos e orientações informadas pelo profissional.'
  },
  // Modelo completo (tattoo / piercing / micropigmentação)
  completo: {
    perguntas: [
      {p:'Procedimento que irá realizar', t:'selecionar', opt:['Tatuagem','Piercing','Micropigmentação','Outro']},
      {p:'Nome completo', t:'texto'},
      {p:'Data de nascimento', t:'texto'},
      {p:'Telefone/WhatsApp para contato', t:'texto'},
      {p:'Peso (kg)', t:'texto'},
      {p:'Altura (cm)', t:'texto'},
      {p:'Está gestante ou amamentando?', t:'selecionar', opt:['Não','Sim','Não sei/Prefiro não informar']},
      {p:'Possui marcapasso?', t:'selecionar', opt:['Não','Sim','Não sei']},
      {p:'É portador(a) de HIV?', t:'selecionar', opt:['Não','Sim','Não sei/Prefiro não informar']},
      {p:'Hepatite (A/B/C) diagnosticada?', t:'selecionar', opt:['Não','Sim','Não sei']},
      {p:'Possui/teve DST/IST diagnosticada?', t:'selecionar', opt:['Não','Sim','Não sei/Prefiro não informar']},
      {p:'Diabetes?', t:'selecionar', opt:['Não','Sim','Não sei']},
      {p:'Hipertensão/Pressão alta?', t:'selecionar', opt:['Não','Sim','Não sei']},
      {p:'Doenças cardíacas?', t:'selecionar', opt:['Não','Sim','Não sei']},
      {p:'Epilepsia/convulsões?', t:'selecionar', opt:['Não','Sim','Não sei']},
      {p:'Alergia a medicamentos/anestésicos/latex?', t:'texto'},
      {p:'Uso de medicamentos contínuos?', t:'texto'},
      {p:'Uso de anticoagulantes (ex: AAS, Marevan, Xarelto)?', t:'selecionar', opt:['Não','Sim','Não sei']},
      {p:'Tendência a sangramento fácil?', t:'selecionar', opt:['Não','Sim','Não sei']},
      {p:'Problemas de cicatrização / queloide?', t:'selecionar', opt:['Não','Sim','Não sei']},
      {p:'Realizou procedimento semelhante antes? (tattoo/piercing/micro)', t:'selecionar', opt:['Não','Sim']},
      {p:'Observações / diagnósticos relevantes', t:'texto'},
      {p:'Declaro que as informações acima são verdadeiras', t:'assinalar'}
    ],
    termos: 'Declaro que as informações prestadas são verdadeiras. Estou ciente dos riscos do procedimento (tatuagem/piercing/micropigmentação), bem como dos cuidados pré e pós-procedimento, e autorizo a realização do procedimento.'
  }
};

let assinaturaPad = null;

function ensureAnCfg(){
  state.cfg.anTermos = state.cfg.anTermos || {};
  state.cfg.anEditavel = state.cfg.anEditavel || {
    perguntas: [
      {p:'Pergunta 1', t:'texto'},
      {p:'Pergunta 2', t:'assinalar'},
      {p:'Pergunta 3', t:'selecionar', opt:['Opção A','Opção B']}
    ],
    termos: 'Digite aqui os termos do modelo editável.'
  };
}

function initSignaturePad(){
  const canvas = document.getElementById('anCanvas');
  const btnLimpar = document.getElementById('btnLimparAss');
  if(!canvas) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  function resize(){
    // Mantém o tamanho visual via CSS (100% x 180px) e ajusta o buffer interno
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    // fundo transparente; não desenha background
  }
  resize();
  window.addEventListener('resize', resize);

  let drawing = false;
  let hasInk = false;
  let last = {x:0,y:0};

  function getPos(e){
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {x: clientX - rect.left, y: clientY - rect.top};
  }
  function start(e){
    drawing = true;
    last = getPos(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    e.preventDefault();
  }
  function move(e){
    if(!drawing) return;
    const pos = getPos(e);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    last = pos;
    hasInk = true;
    e.preventDefault();
  }
  function end(){
    drawing = false;
  }
  canvas.addEventListener('pointerdown', start);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  if(btnLimpar){
    btnLimpar.onclick = ()=>{
      ctx.clearRect(0,0,canvas.width,canvas.height);
      hasInk = false;
    };
  }

  assinaturaPad = {
    clear: ()=>{ctx.clearRect(0,0,canvas.width,canvas.height); hasInk=false;},
    hasInk: ()=>hasInk,
    toDataURL: ()=> hasInk ? canvas.toDataURL('image/png') : ''
  };
}

function renderCamposAn(perguntas){
  const box = document.getElementById('anCampos');
  if(!box) return;
  box.innerHTML = '';
  (perguntas||[]).forEach((q,idx)=>{
    const p = (q && q.p) ? String(q.p) : `Pergunta ${idx+1}`;
    const t = (q && q.t) ? String(q.t) : 'texto';
    const div = document.createElement('div');
    div.innerHTML = `<label class="label">${escapeHtml(p)}</label>`;

    if(t === 'assinalar'){
      const wrap = document.createElement('label');
      wrap.style.display='flex';
      wrap.style.alignItems='center';
      wrap.style.gap='10px';
      wrap.style.padding='10px 12px';
      wrap.style.border='1px solid rgba(255,255,255,.08)';
      wrap.style.borderRadius='14px';
      wrap.style.background='rgba(0,0,0,.18)';
      wrap.innerHTML = `<input type="checkbox" data-pergunta="${escapeHtml(p)}" data-tipo="assinalar" style="width:18px;height:18px" /> <span class="muted">Assinalar</span>`;
      div.appendChild(wrap);
    } else if(t === 'selecionar'){
      const sel = document.createElement('select');
      sel.className = 'input';
      sel.setAttribute('data-pergunta', p);
      sel.setAttribute('data-tipo', 'selecionar');
      const opts = Array.isArray(q.opt) ? q.opt : (typeof q.opt === 'string' ? q.opt.split(',').map(x=>x.trim()).filter(Boolean) : []);
      sel.innerHTML = `<option value="">Selecione...</option>` + opts.map(o=>`<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
      div.appendChild(sel);
    } else {
      const inp = document.createElement('input');
      inp.className='input';
      inp.setAttribute('data-pergunta', p);
      inp.setAttribute('data-tipo', 'texto');
      div.appendChild(inp);
    }
    box.appendChild(div);
  });
}

function buildEditor(){
  const ed = document.getElementById('anEditor');
  if(!ed) return;
  ed.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'row';
  head.style.justifyContent='space-between';
  head.innerHTML = `
    <div>
      <strong>Editar modelo</strong><div class="muted sm">Defina perguntas e o tipo de resposta.</div>
    </div>
    <div class="row" style="gap:8px">
      <button class="btn ghost sm" id="btnAnAddQ" type="button"><i class="fa-solid fa-plus"></i> Adicionar pergunta</button>
      <button class="btn primary sm" id="btnAnAplicar" type="button"><i class="fa-solid fa-check"></i> Aplicar</button>
    </div>`;
  ed.appendChild(head);

  const list = document.createElement('div');
  list.id = 'anEditorList';
  ed.appendChild(list);

  function renderList(){
    ensureAnCfg();
    list.innerHTML = '';
    (state.cfg.anEditavel.perguntas||[]).forEach((q,idx)=>{
      const item = document.createElement('div');
      item.className = 'an-qitem';
      const t = q.t || 'texto';
      const opts = Array.isArray(q.opt) ? q.opt.join(', ') : (q.opt||'');
      item.innerHTML = `
        <div class="an-qmeta">
          <input class="input" data-ed="p" data-idx="${idx}" placeholder="Pergunta" value="${(q.p||'').replace(/"/g,'&quot;')}" />
          <div class="an-opt" style="display:${t==='selecionar'?'block':'none'}">
            <input class="input" data-ed="opt" data-idx="${idx}" placeholder="Opções (separadas por vírgula)" value="${String(opts).replace(/"/g,'&quot;')}" />
          </div>
        </div>
        <div>
          <select class="input" data-ed="t" data-idx="${idx}">
            <option value="texto" ${t==='texto'?'selected':''}>Texto</option>
            <option value="assinalar" ${t==='assinalar'?'selected':''}>Assinalar</option>
            <option value="selecionar" ${t==='selecionar'?'selected':''}>Selecionar</option>
          </select>
          <div class="an-qact" style="margin-top:8px">
            <button class="btn danger sm" data-ed="del" data-idx="${idx}" type="button"><i class="fa-solid fa-trash"></i> Remover</button>
          </div>
        </div>`;
      list.appendChild(item);
    });

    // handlers
    list.querySelectorAll('[data-ed="t"]').forEach(sel=>{
      sel.onchange = ()=>{
        const idx = Number(sel.dataset.idx);
        ensureAnCfg();
        state.cfg.anEditavel.perguntas[idx].t = sel.value;
        renderList();
      };
    });
    list.querySelectorAll('[data-ed="p"]').forEach(inp=>{
      inp.oninput = ()=>{
        const idx = Number(inp.dataset.idx);
        ensureAnCfg();
        state.cfg.anEditavel.perguntas[idx].p = inp.value;
      };
    });
    list.querySelectorAll('[data-ed="opt"]').forEach(inp=>{
      inp.oninput = ()=>{
        const idx = Number(inp.dataset.idx);
        ensureAnCfg();
        state.cfg.anEditavel.perguntas[idx].opt = inp.value;
      };
    });
    list.querySelectorAll('[data-ed="del"]').forEach(btn=>{
      btn.onclick = ()=>{
        const idx = Number(btn.dataset.idx);
        ensureAnCfg();
        state.cfg.anEditavel.perguntas.splice(idx,1);
        renderList();
      };
    });
  }

  function addQ(){
    ensureAnCfg();
    state.cfg.anEditavel.perguntas.push({p:`Pergunta ${state.cfg.anEditavel.perguntas.length+1}`, t:'texto'});
    renderList();
  }

  function aplicar(){
    ensureAnCfg();
    // normaliza
    state.cfg.anEditavel.perguntas = (state.cfg.anEditavel.perguntas||[]).map(q=>{
      const t = q.t || 'texto';
      const nq = {p:(q.p||'').trim(), t};
      if(t==='selecionar'){
        const raw = Array.isArray(q.opt) ? q.opt.join(',') : (q.opt||'');
        nq.opt = raw.split(',').map(x=>x.trim()).filter(Boolean);
      }
      return nq;
    }).filter(q=>q.p);
    // aplica no formulário
    renderCamposAn(state.cfg.anEditavel.perguntas);
  }

  const btnAdd = ed.querySelector('#btnAnAddQ');
  const btnAplicar = ed.querySelector('#btnAnAplicar');
  if(btnAdd) btnAdd.onclick = addQ;
  if(btnAplicar) btnAplicar.onclick = aplicar;

  renderList();
}

function getModeloConfig(key){
  ensureAnCfg();
  // O "modelo editável" foi removido. Mantemos compatibilidade caso exista algum dado antigo.
  if(key === 'editavel') key = 'completo';
  return MODELOS_PADRAO[key] || MODELOS_PADRAO.basico;
}

function gerarModelo(key){
  ensureAnCfg();
  // Normaliza chave (compatibilidade com versões antigas)
  const modeloKey = (key === 'editavel') ? 'completo' : key;
  const conf = getModeloConfig(modeloKey);

  const ed = document.getElementById('anEditor');
  if(ed){
    // "Modelo Editável" removido: editor sempre oculto.
    ed.classList.add('hidden');
    ed.innerHTML = '';
  }

  renderCamposAn(conf.perguntas || []);

  const termosEl = document.getElementById('anTermos');
  if(termosEl){
    const t = (state.cfg.anTermos && state.cfg.anTermos[modeloKey] != null) ? state.cfg.anTermos[modeloKey] : (conf.termos || '');
    termosEl.value = t;
    termosEl.oninput = ()=>{
      ensureAnCfg();
      state.cfg.anTermos[modeloKey] = termosEl.value;
    };
  }

  const box = document.getElementById('anCampos');
  if(box) box.dataset.modelo = modeloKey;

  // reinicia assinatura ao trocar modelo
  if(assinaturaPad) assinaturaPad.clear();
}

function salvarAnamnese(){
  const idc = document.getElementById('anCliente').value;
  const cliente = state.data.clientes.find(c=>c.id===idc);
  if(!cliente) return alert('Selecione um cliente.');

  const modelo = (document.getElementById('anCampos')?.dataset.modelo) || 'basico';

  // coleta respostas
  const respostas = [];
  const campos = document.querySelectorAll('#anCampos [data-pergunta]');
  campos.forEach(el=>{
    const p = el.dataset.pergunta;
    const t = el.dataset.tipo || (el.type==='checkbox'?'assinalar':(el.tagName==='SELECT'?'selecionar':'texto'));
    let v = '';
    if(el.type === 'checkbox') v = el.checked ? 'Sim' : 'Não';
    else v = (el.value||'').trim();
    respostas.push({p,t,v});
  });

  const termos = (document.getElementById('anTermos')?.value || '').trim();
  const assinatura = assinaturaPad ? assinaturaPad.toDataURL() : '';

  const obj = {
    id: uid(),
    clienteId: idc,
    clienteNome: cliente.nome,
    modelo,
    respostas,
    termos,
    assinatura,
    data: new Date().toISOString(),
    dataBr: formatDateBR(new Date())
  };

  state.data.an.push(obj); savePerfil();

  document.getElementById('anCampos').innerHTML='';
  if(assinaturaPad) assinaturaPad.clear();
  renderAn();
}

function renderAn(){
  const q = (document.getElementById('buscaAn').value||'').toLowerCase();
  const box = document.getElementById('listaAn'); box.innerHTML='';

  state.data.an
    .slice().sort((a,b)=>b.data.localeCompare(a.data))
    .filter(a=>!q || (a.clienteNome||'').toLowerCase().includes(q))
    .forEach(a=>{
      const div = document.createElement('div');
      div.className='item';

      const termosTxt = a.termos ? `

TERMO:
${a.termos}` : '';
      const respostasTxt = (a.respostas||[]).map(r=>`• ${r.p}: ${r.v}`).join('\n');

      div.innerHTML = `
        <strong>${escapeHtml(a.dataBr||'')} • ${escapeHtml(a.clienteNome||'')} — ${escapeHtml((a.modelo||'').toUpperCase())}</strong>
        <pre class="muted" style="white-space:pre-wrap">${escapeHtml(respostasTxt)}${escapeHtml(termosTxt)}</pre>
        ${(a.assinatura && /^data:image\//i.test(String(a.assinatura))) ? `<div style="margin:10px 0"><div class="muted sm" style="margin-bottom:6px">Assinatura:</div><img alt="Assinatura" src="${escapeHtml(a.assinatura)}" style="max-width:100%;border:1px solid rgba(255,255,255,.10);border-radius:12px" /></div>` : ''}
        <div class="row" style="gap:8px">
          <button class="btn ghost sm" data-id="${a.id}" data-act="export"><i class="fa-solid fa-file-arrow-down"></i> Exportar</button>
          <button class="btn danger sm" data-id="${a.id}" data-act="del"><i class="fa-solid fa-trash"></i> Excluir</button>
        </div>`;
      box.appendChild(div);
    });

  document.querySelectorAll('#listaAn [data-act="del"]').forEach(b=>b.onclick=()=>{state.data.an=state.data.an.filter(x=>x.id!==b.dataset.id); savePerfil(); renderAn();});
  document.querySelectorAll('#listaAn [data-act="export"]').forEach(b=>b.onclick=()=>exportSingle('anamnese', state.data.an.find(x=>x.id===b.dataset.id)));
}

function initAnamnese(){
  ensureAnCfg();
  initSignaturePad();
  // modelo padrão ao entrar
  if(document.getElementById('anCampos') && !document.getElementById('anCampos').dataset.modelo){
    gerarModelo('basico');
  }
}

/* ======= ADMIN / BACKUP / RELATÓRIO ======= */

function exportarDados(){
  const blob = new Blob([JSON.stringify({perfilId:state.perfilId, cfg:state.cfg, data:state.data},null,2)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `studioLH_${state.perfilId}.json`; a.click();
}
function exportSingle(nome,obj){
  const blob = new Blob([JSON.stringify(obj,null,2)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${nome}_${obj.id}.json`; a.click();
}
function importarDados(evt){
  const file = evt.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      const pack = JSON.parse(e.target.result);
      if(!confirm('Isto substituirá os dados deste perfil. Continuar?')) return;
      state.data = pack.data||state.data; state.cfg = pack.cfg||state.cfg; savePerfil(); refreshAll(); alert('Importado com sucesso.');
    }catch(err){ alert('Arquivo inválido.'); }
  };
  reader.readAsText(file);
}

function downloadCSV(filename, rows){
  const csv = rows.map(r => r.map(v => {
    const s = String(v ?? '').replace(/"/g,'""');
    return `"${s}"`;
  }).join(';')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportAgendaCSV(){
  const rows = [['Data','Hora','Dia inteiro','Cliente','Serviço','Valor','Status','Obs']];
  (state.data.agenda||[]).forEach(a=>{
    rows.push([
      a.dataBr || (a.data ? formatDateBR(a.data) : ''),
      a.diaInteiro ? 'Dia inteiro' : (a.inicioHora || a.hora || ''),
      a.diaInteiro ? 'SIM' : 'NÃO',
      a.clienteNome || '',
      a.servico || '',
      money(a.valor||0, state.cfg.moeda),
      (a.status||'agendado').toUpperCase(),
      a.obs || ''
    ]);
  });
  downloadCSV('agenda.csv', rows);
}

function exportTxCSV(){
  const rows = [['Data','Tipo','Descrição','Categoria','Valor']];
  (state.data.tx||[]).forEach(t=>{
    rows.push([
      t.dataBr || (t.data ? formatDateBR(t.data) : ''),
      t.tipo || '',
      t.desc || '',
      t.cat || '',
      money(t.valor||0, state.cfg.moeda)
    ]);
  });
  downloadCSV('financeiro.csv', rows);
}
function _plainClone(value){
  // state.data/state.cfg usam Proxy reativo; structuredClone(Proxy) pode lançar DataCloneError.
  return JSON.parse(JSON.stringify(value == null ? null : value));
}
function _restoreBackupPayload(b){
  if(!b || !b.data) throw new Error('Backup inválido.');
  // Mantém a lista de backups atual fora do snapshot para evitar backups recursivos e crescimento exponencial.
  const currentBackups = _plainClone(state.data?.backups || []);
  const restoredData = _plainClone(b.data) || {};
  restoredData.backups = currentBackups;
  state.data = makeReactive(restoredData, ()=>scheduleCloudSync());
  state.cfg = makeReactive(Object.assign({}, state.cfg || {}, _plainClone(b.cfg) || {}), ()=>scheduleCloudSync());
}
function backupManual(silent = false){
  // Quando chamado por onclick, o primeiro argumento pode ser um Event.
  if (typeof silent !== 'boolean') silent = false;
  try{
    const dataSnapshot = _plainClone(state.data) || {};
    // Um backup não deve conter outros backups dentro dele.
    dataSnapshot.backups = [];
    const payload = {date:new Date().toISOString(), data:dataSnapshot, cfg:_plainClone(state.cfg)};
    state.data.backups.unshift(payload);
    // manter últimos 10
    state.data.backups = state.data.backups.slice(0,10);
    savePerfil();
    if(!silent) alert('Backup criado.');
  }catch(e){
    console.error('Erro ao criar backup', e);
    if(!silent) alert('Não foi possível criar o backup.');
  }
}
function recuperarUltimo(){
  const b = state.data.backups?.[0];
  if(!b) return alert('Sem backups disponíveis.');
  if(!confirm('Restaurar o último backup? Isto substituirá os dados atuais.')) return;
  try{
    _restoreBackupPayload(b); savePerfil(); refreshAll(); alert('Restaurado com sucesso!');
  }catch(e){ console.error('Erro ao restaurar backup', e); alert('Não foi possível restaurar o backup.'); }
}
function refreshDbStatus(){
  $('#dbUltima').textContent = new Date().toLocaleString('pt-BR');
  const bytes = new Blob([JSON.stringify(state.data)]).size;
  $('#stTam').textContent = (bytes/1024).toFixed(2)+' KB';
  const regs = state.data.clientes.length + state.data.agenda.length + state.data.tx.length + state.data.an.length;
  $('#stRegs').textContent = regs;
  $('#stBkp').textContent = (state.data.backups||[]).length;
  $('#stSeg').textContent = (state.perfis?.find?.(p=>p.id===state.perfilId)?.senhaHash || state.cfg.senhaHash) ? '🔒 Protegido' : 'Desprotegido';
  // lista backups
  const list = $('#listaBackups'); list.innerHTML='';
  (state.data.backups||[]).forEach((b,idx)=>{
    const d = document.createElement('div'); d.className='item';
    d.innerHTML = `<strong>📅 ${new Date(b.date).toLocaleString('pt-BR')}</strong>
      <div class="row"><button class="btn ghost sm" data-i="${idx}" data-act="rest"><i class="fa-solid fa-rotate-left"></i> Restaurar</button></div>`;
    list.appendChild(d);
  });
  $$('#listaBackups [data-act="rest"]').forEach(btn=>btn.onclick=()=>{
    const i=+btn.dataset.i;
    const selected = state.data.backups?.[i];
    if(!selected) return alert('Backup não encontrado.');
    if(!confirm('Restaurar este backup? Isto substituirá os dados atuais.')) return;
    try{
      _restoreBackupPayload(selected); savePerfil(); refreshAll(); alert('Backup restaurado.');
    }catch(e){ console.error('Erro ao restaurar backup', e); alert('Não foi possível restaurar o backup.'); }
  });
}
function exportarRelatorio(){
  const totalR = state.data.tx.filter(t=>t.tipo==='receita').reduce((s,t)=>s+t.valor,0);
  const totalD = state.data.tx.filter(t=>t.tipo==='despesa').reduce((s,t)=>s+t.valor,0);
  const linhas = [
    `Estúdio: ${state.cfg.estudio}`,
    `Saldo Atual: ${money(totalR-totalD, state.cfg.moeda)}`,
    `Clientes: ${state.data.clientes.length}`,
    `Agendamentos: ${state.data.agenda.length}`,
    `Transações: ${state.data.tx.length}`
  ].join('\n');
  const blob = new Blob([linhas], {type:'text/plain;charset=utf-8'});
  const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='relatorio_2letters.txt'; a.click();
}
function refreshSystemStats(){
  $('#stClientes').textContent = state.data.clientes.length;
  const hoje = todayISO();
  $('#stHoje').textContent = state.data.agenda.filter(a=>a.data===hoje).length;
  const ym = todayISO().slice(0,7);
  const recMes = state.data.tx.filter(t=>t.tipo==='receita' && t.data.startsWith(ym)).reduce((s,t)=>s+t.valor,0);
  $('#stMes').textContent = money(recMes, state.cfg.moeda);
  $('#stTx').textContent = state.data.tx.length;

  // Fiados (Dashboard)
  try {
    if (!Array.isArray(state.data.fiados)) state.data.fiados = [];
    const fiados = state.data.fiados || [];
    // usa parcelas como fonte de verdade
    const abertos = fiados.filter(f=>{
      const parcelas = Array.isArray(f.parcelas) ? f.parcelas : [];
      const unpaid = parcelas.filter(p=>!p.pago).reduce((s,p)=>s+Number(p.valor||0),0);
      return unpaid > 0;
    });
    const abertoSum = abertos.reduce((s,f)=>{
      const parcelas = Array.isArray(f.parcelas) ? f.parcelas : [];
      const unpaid = parcelas.filter(p=>!p.pago).reduce((ss,p)=>ss+Number(p.valor||0),0);
      return s + unpaid;
    },0);

    const pagosMesParcelas = fiados.flatMap(f=>{
      const parcelas = Array.isArray(f.parcelas) ? f.parcelas : [];
      return parcelas.filter(p=>p.pago && String(p.pagoData||'').startsWith(ym)).map(p=>({f,p}));
    });
    const recebMes = pagosMesParcelas.reduce((s,x)=>s+Number(x.p.valor||0),0);

    if ($('#stFiadosAberto')) $('#stFiadosAberto').textContent = money(abertoSum, state.cfg.moeda);
    if ($('#stFiadosQtd')) $('#stFiadosQtd').textContent = String(abertos.length);
    if ($('#stFiadosRecebMes')) $('#stFiadosRecebMes').textContent = money(recebMes, state.cfg.moeda);
    if ($('#stFiadosPagosMes')) $('#stFiadosPagosMes').textContent = String(pagosMesParcelas.length);

    const list = $('#dashFiadosList');
    if (list){
      const top = abertos.slice().sort((a,b)=>{
        const va = a.venc || a.data || '';
        const vb = b.venc || b.data || '';
        return String(va).localeCompare(String(vb));
      }).slice(0,8);

      if (!top.length){
        list.innerHTML = '<p class="muted">Nenhum fiado em aberto.</p>';
      } else {
        list.innerHTML = '';
        top.forEach(f=>{
          const div = document.createElement('div');
          div.className = 'item';
          const parcelas = Array.isArray(f.parcelas) ? f.parcelas : [];
          const abertoFiado = parcelas.filter(p=>!p.pago).reduce((s,p)=>s+Number(p.valor||0),0);
          const proxVenc = parcelas.filter(p=>!p.pago && p.venc).map(p=>p.venc).sort()[0] || (f.venc||'');
          const vencLabel = proxVenc ? `Próx. venc: ${formatDateBR(proxVenc)}` : 'Sem vencimento';
          div.innerHTML = `
            <strong>${escapeHtml(f.clienteNome || 'Cliente')} — ${money(abertoFiado, state.cfg.moeda)}</strong>
            <div class="muted">${escapeHtml(vencLabel)}${escapeHtml(f.desc ? ' • ' + f.desc : '')}</div>
          `;
          list.appendChild(div);
        });
      }
    }
  } catch(e) {
    console.warn('Falha ao atualizar stats de fiados', e);
  }
}

/* ======= CONFIG / AÇÕES ======= */
function salvarCfg(){
  state.cfg.estudio = $('#cfgEstudio').value.trim()||'2letters';
  state.cfg.moeda   = $('#cfgMoeda').value||'BRL';
  state.cfg.tema    = $('#cfgTema').value||'auto';
  state.cfg.wpp24   = $('#cfgWpp24').checked;
  state.cfg.wpp2    = $('#cfgWpp2').checked;
  state.cfg.autoBackup = $('#cfgAutoBackup').checked;
  state.cfg.msgWpp  = $('#cfgMsgWpp').value.trim()||state.cfg.msgWpp;
  if ($('#cfgMsgWppConcluido')) state.cfg.msgWppConcluido = $('#cfgMsgWppConcluido').value.trim() || state.cfg.msgWppConcluido;
  if ($('#cfgMsgWppCancelado')) state.cfg.msgWppCancelado = $('#cfgMsgWppCancelado').value.trim() || state.cfg.msgWppCancelado;
  if ($('#cfgPixChave')) state.cfg.pixChave = $('#cfgPixChave').value.trim() || state.cfg.pixChave;
  savePerfil();
  applyTheme(state.cfg.tema);
}
function salvarCores(){
  state.cfg.cores = {ag:$('#corAg').value, co:$('#corCo').value, ca:$('#corCa').value};
  document.documentElement.style.setProperty('--cor-ag', state.cfg.cores.ag);
  document.documentElement.style.setProperty('--cor-co', state.cfg.cores.co);
  document.documentElement.style.setProperty('--cor-ca', state.cfg.cores.ca);
  savePerfil(); alert('Cores atualizadas.');
}
function limparCache(){
  if(!('caches' in window)) return alert('Cache não disponível neste navegador.');
  caches.keys().then(keys=>Promise.all(keys.map(k=>caches.delete(k)))).then(()=>alert('Cache limpo.'));
}
function resetApp(){
  if(!confirm('Resetar aplicativo (mantém perfis, zera dados deste perfil)?')) return;
  state.data = {clientes:[], servicos:[], agenda:[], tx:[], fiados:[], an:[], usuarios:[], backups:[], lastLogin:state.data.lastLogin};
  savePerfil(); refreshAll(); alert('Aplicativo resetado para este perfil.');
}
function testarConexao(){
  alert(navigator.onLine ? 'Conectado à internet.' : 'Sem conexão (offline).');
}
function trocarSenha(){
  const atual = $('#segAtual').value, nova = $('#segNova').value, conf = $('#segConf').value;
  const perfil = state.perfis.find(p=>p.id===state.perfilId);
  if(perfil.senhaHash && simpleHash(atual)!==perfil.senhaHash) return alert('Senha atual incorreta.');
  if(!nova || nova!==conf) return alert('Confirme a nova senha corretamente.');
  perfil.senhaHash = simpleHash(nova);
  savePerfis(); $('#warnSenha').classList.add('hidden'); alert('Senha atualizada!');
}

/* ======= AUTO BACKUP ======= */
function autoBackupIfNeeded(){
  if(!state.cfg.autoBackup) return;
  const last = state.data.backups?.[0]?.date;
  const d = new Date();
  const isNewDay = !last || (new Date(last)).toDateString() !== d.toDateString();
  if(isNewDay) backupManual(true);
}

/* ======= RENDER ALL ======= */


function renderMainCalendar(){
  const resumoCard   = document.getElementById('agendaResumoDiaCard');
  const resumoTitulo = document.getElementById('agendaResumoDiaTitulo');
  const resumoLista  = document.getElementById('agendaResumoDiaLista');

  let currentResumoDateISO = null;
  let lastScrollLeft = 0;

  const formatDateBrLong = (iso) => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString('pt-BR', {
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  };

  const buildResumoDia = (diaIso) => {
    if (!resumoCard || !resumoLista || !resumoTitulo) return;

    currentResumoDateISO = diaIso;

    const ags = (state.data.agenda || [])
      .filter(a => a && a.data === diaIso)
      .slice()
      .sort((a, b) => {
        const hA = (a.inicioHora || a.hora || '').padStart(5, '0');
        const hB = (b.inicioHora || b.hora || '').padStart(5, '0');
        return hA.localeCompare(hB);
      });

    resumoTitulo.textContent = formatDateBrLong(diaIso);

    if (ags.length === 0) {
      resumoLista.innerHTML = `
        <div class="agenda-resumo-card status-empty" style="flex:0 0 100%; text-align:center; min-height:80px; display:grid; place-items:center; opacity:0.8; padding:20px; border: 1px dashed var(--muted);">
          Não há agendamento para este dia.
        </div>
      `;
    } else {
      resumoLista.innerHTML = '';
      ags.forEach(a => {
        const nome = a.clienteNome || 'Sem nome';
        const dataBr = a.dataBr || (a.data || '').split('-').reverse().join('/');
        const diaInteiro = !!a.diaInteiro;
        const inicioHora = a.inicioHora || a.hora || '';
        const fimHora = a.fimHora || '';
        const descricao = a.obs && a.obs.trim() ? a.obs.trim() : (a.servico || '');
        const status = a.status || 'agendado';

        let linhaHorario = '';
        if (diaInteiro) linhaHorario = 'Dia inteiro';
        else if (inicioHora && fimHora) linhaHorario = inicioHora + ' - ' + fimHora;
        else if (inicioHora) linhaHorario = inicioHora;

        let detalheHoras = '';
        if (!diaInteiro && inicioHora) {
          detalheHoras = 'Início: ' + inicioHora + (fimHora ? ' • Fim: ' + fimHora : '');
        }

        const card = document.createElement('div');
        card.className = 'agenda-resumo-card status-' + status;
        card.innerHTML = `
          <div class="agenda-resumo-cliente">${escapeHtml(nome)}</div>
          <div class="agenda-resumo-dia-linha">${dataBr}</div>
          <div class="agenda-resumo-hora">${linhaHorario}</div>
          <div class="agenda-resumo-detalhe-horas">${detalheHoras}</div>
          <div class="agenda-resumo-descricao">${escapeHtml(descricao || '')}</div>
        `;
        resumoLista.appendChild(card);
      });
    }

    // Reseta scroll e listeners
    resumoLista.scrollLeft = 0;
    lastScrollLeft = 0;

    // Removido: antes o onscroll mudava de dia quando chegava no fim/início do carrossel.
    // Agora a rolagem horizontal só navega entre os agendamentos do próprio dia.
    resumoLista.onscroll = null;

  };

  const changeDayFromScroll = (offset) => {
    if (!currentResumoDateISO) return;
    const base = _parseISODateOnlyLocal(currentResumoDateISO);
    const next = new Date(base);
    next.setDate(base.getDate() + offset);
    const nextISO = _formatISODateOnlyLocal(next);

    const mainContainer = document.getElementById('mainCalendarContainer');
    if (!mainContainer) return;

    const tryClickDay = () => {
      const dayEl = mainContainer.querySelector('.calendar-day[data-date="' + nextISO + '"]') ||
                    mainContainer.querySelector('.calendar-week-strip-day[data-date="' + nextISO + '"]');
      if (dayEl) {
        dayEl.click(); // dispara onDateSelect + highlight
        return true;
      }
      return false;
    };

    if (tryClickDay()) {
      return;
    }

    // Se não encontrou, provavelmente está em outro mês -> navega
    const nextBtn = mainContainer.querySelector('.calendar-nav-btn[data-action="next"]');
    const prevBtn = mainContainer.querySelector('.calendar-nav-btn[data-action="prev"]');
    const useNext = next > base;

    const btn = useNext ? nextBtn : prevBtn;
    if (btn) {
      btn.click();
      setTimeout(tryClickDay, 40);
    }
  };

  const onDateSelect = (dateISO) => {
    // Linhas comentadas para evitar o scroll indesejado:
    // if ($('#agInicioData')) $('#agInicioData').value = dateISO; 
    // if ($('#agFimData') && !$('#agFimData').value) $('#agFimData').value = dateISO; 
    // if ($('#agData')) $('#agData').value = dateISO; 
    
    // Mantém apenas a função de carregar o resumo dos agendamentos do dia:
    buildResumoDia(dateISO);

    // Mantém apenas ajuste de rolagem horizontal do resumo (não mexe na rolagem vertical da página):
    const resumoScroll = document.getElementById('agendaResumoScroll');
    if (resumoScroll) {
      setTimeout(() => {
        resumoScroll.scrollLeft = 0;
      }, 0);
    }
}
;

  const baseDateStr =
    ($('#agInicioData') && $('#agInicioData').value) ||
    ($('#agData') && $('#agData').value) ||
    todayISO();

  window.renderCalendar('mainCalendarContainer', baseDateStr, onDateSelect, state.data.agenda);

  // monta resumo inicial
  onDateSelect(baseDateStr);
}



function initVisaoDonoControles(){
  const sel = document.getElementById('visaoDonoFiltroFuncionario');
  const inpMes = document.getElementById('visaoDonoFiltroMes');
  const btnLimpar = document.getElementById('visaoDonoBtnLimparFiltros');
  const btnRanking = document.getElementById('visaoDonoBtnRanking');
  if (!sel || !inpMes || !btnLimpar || !btnRanking) return;

  if (sel.dataset.bound === '1') return; // evita duplicar listeners
  sel.dataset.bound = '1';

  sel.addEventListener('change', ()=>{
    state.visaoDono = state.visaoDono || {};
    state.visaoDono.funcionarioId = sel.value;
    renderVisaoDono();
  });

  inpMes.addEventListener('change', ()=>{
    state.visaoDono = state.visaoDono || {};
    state.visaoDono.mes = inpMes.value || '';
    renderVisaoDono();
  });

  btnLimpar.addEventListener('click', ()=>{
    state.visaoDono = state.visaoDono || {};
    state.visaoDono.funcionarioId = '__all__';
    state.visaoDono.mes = '';
    sel.value = '__all__';
    inpMes.value = '';
    renderVisaoDono();
  });

  btnRanking.addEventListener('click', ()=>{
    state.visaoDono = state.visaoDono || {};
    const atual = !(state.visaoDono.ranking === false);
    state.visaoDono.ranking = !atual;
    btnRanking.textContent = state.visaoDono.ranking ? 'Ranking: ON' : 'Ranking: OFF';
    renderVisaoDono();
  });
}


function renderVisaoDono(){
  const containerResumo = document.getElementById('visaoDonoResumo');
  const containerLista = document.getElementById('visaoDonoLista');
  if (!containerResumo || !containerLista) return;

  const perfilAtual = getPerfilAtual();
  if (!perfilAtual || !isPerfilAdmin(perfilAtual.id)) {
    containerResumo.innerHTML = '';
    containerLista.innerHTML = '<p class="muted">Apenas o administrador tem acesso a esta visão.</p>';
    return;
  }

  initVisaoDonoControles();

  // mantém controles sincronizados com o estado
  try{
    const btnRanking = document.getElementById('visaoDonoBtnRanking');
    const sel = document.getElementById('visaoDonoFiltroFuncionario');
    const inpMes = document.getElementById('visaoDonoFiltroMes');
    const rOn = !(state.visaoDono && state.visaoDono.ranking === false);
    if (btnRanking) btnRanking.textContent = rOn ? 'Ranking: ON' : 'Ranking: OFF';
    if (sel) sel.value = (state.visaoDono && state.visaoDono.funcionarioId) ? String(state.visaoDono.funcionarioId) : '__all__';
    if (inpMes) inpMes.value = (state.visaoDono && state.visaoDono.mes) ? String(state.visaoDono.mes) : '';
  }catch(_){}

  // UI de carregamento (evita tela vazia em conexões lentas)
  containerResumo.innerHTML = `
    <div class="kpi green dp-owner-kpi"><span class="kpi-label">Receitas totais</span><span class="kpi-value">...</span></div>
    <div class="kpi red dp-owner-kpi"><span class="kpi-label">Despesas totais</span><span class="kpi-value">...</span></div>
    <div class="kpi blue dp-owner-kpi"><span class="kpi-label">Saldo geral</span><span class="kpi-value">...</span></div>
  `;
  containerLista.innerHTML = '<p class="muted">Carregando faturamento dos funcionários...</p>';

  // Carrega do Firestore (cloud-first)
  renderVisaoDonoAsync().catch(e=>{
    console.error('Erro na Visão do Dono', e);
    const msg = (e && (e.code || e.message)) ? String(e.code || e.message) : 'Erro desconhecido';
    if (/permission-denied/i.test(msg)) {
      containerLista.innerHTML = '<p class="muted">Sem permissão para ler os dados financeiros dos funcionários. Ajuste as Rules para permitir leitura do admin em perfis/{uid}/tx.</p>';
    } else {
      containerLista.innerHTML = '<p class="muted">Não foi possível carregar a visão do dono.</p>';
    }
  });
}

async function renderVisaoDonoAsync(){
  const containerResumo = document.getElementById('visaoDonoResumo');
  const containerLista = document.getElementById('visaoDonoLista');
  if (!containerResumo || !containerLista) return;

  const perfilAtual = getPerfilAtual();
  if (!perfilAtual || !isPerfilAdmin(perfilAtual.id)) return;

  if (!window.db || !auth || !auth.currentUser) {
    containerLista.innerHTML = '<p class="muted">Firestore não inicializado.</p>';
    return;
  }

  const adminUid = String(auth.currentUser.uid);

  const filtroFuncionario = (state.visaoDono && state.visaoDono.funcionarioId) ? String(state.visaoDono.funcionarioId) : '__all__';
  const filtroMes = (state.visaoDono && state.visaoDono.mes) ? String(state.visaoDono.mes) : '';
  const usarRanking = !(state.visaoDono && state.visaoDono.ranking === false);

  // Lista de funcionários registrados (perfis_usuarios), incluindo o próprio admin
  const perfis = Array.isArray(state.perfis) ? state.perfis : [];
  const funcionarios = perfis
    .filter(p => p && p.id && (String(p.ownerId||'') === adminUid))
    .map(p => ({ id: String(p.id), nome: p.nome || p.email || String(p.id) }));

  // Garante o próprio admin na lista
  if (!funcionarios.find(f => f.id === adminUid)) {
    funcionarios.unshift({ id: adminUid, nome: 'Você (Administrador)' });
  } else {
    // Renomeia o admin para ficar claro
    funcionarios.forEach(f=>{ if (f.id === adminUid) f.nome = f.nome || 'Você (Administrador)'; });
  }

  // Atualiza dropdown de funcionários
  try{
    const sel = document.getElementById('visaoDonoFiltroFuncionario');
    if (sel){
      const current = filtroFuncionario || '__all__';
      const opts = [];
      opts.push({id:'__all__', nome:'Todos os funcionários'});
      funcionarios.forEach(f=>opts.push({id:String(f.id), nome:f.nome}));
      sel.innerHTML = opts.map(o=>`<option value="${o.id}">${escapeHtml(o.nome)}</option>`).join('');
      sel.value = opts.find(o=>o.id===current) ? current : '__all__';
    }
    const inpMes = document.getElementById('visaoDonoFiltroMes');
    if (inpMes){
      inpMes.value = filtroMes || '';
    }
    const btnRanking = document.getElementById('visaoDonoBtnRanking');
    if (btnRanking){
      btnRanking.textContent = usarRanking ? 'Ranking: ON' : 'Ranking: OFF';
    }
  }catch(e){}

  // Carrega tx de cada funcionário e soma
  const rows = [];
  let totalGeralReceitas = 0;
  let totalGeralDespesas = 0;

  const sharedTxSnap = await db.collection('perfis').doc(adminUid).collection('tx').get();
  const sharedTx = [];
  sharedTxSnap.forEach(doc=>{ const t=doc.data()||{}; if(!t.id)t.id=doc.id; sharedTx.push(t); });
  for (const f of funcionarios) {
    let rec = 0, desp = 0;
    sharedTx.forEach(t=>{
      const actor = String(t.createdByUid || adminUid); // legado sem autoria pertence ao admin
      if (actor !== String(f.id)) return;
      const dataIso = String(t.data || t.dataISO || t.data_iso || t.dataStr || '');
      if (filtroMes && (!dataIso || !dataIso.startsWith(filtroMes))) return;
      const v = Number(t.valor || 0) || 0;
      if (t.tipo === 'receita') rec += v;
      else if (t.tipo === 'despesa') desp += v;
    });
    const saldo = rec - desp;
    totalGeralReceitas += rec; totalGeralDespesas += desp;
    rows.push({id:f.id,nome:f.nome,faturamento:rec,receitas:rec,despesas:desp,saldo});
  }

  // Aplica filtro por funcionário (se houver)
  const rowsFiltradas = (filtroFuncionario && filtroFuncionario !== '__all__')
    ? rows.filter(r => String(r.id) === String(filtroFuncionario))
    : rows;

  const totalRecFiltrado = rowsFiltradas.reduce((s,r)=>s+(Number(r.receitas||0)||0),0);
  const totalDespFiltrado = rowsFiltradas.reduce((s,r)=>s+(Number(r.despesas||0)||0),0);

  // KPIs
  containerResumo.innerHTML = `
    <div class="kpi green dp-owner-kpi">
      <span class="kpi-label">Receitas totais</span>
      <span class="kpi-value">${money(totalRecFiltrado, state.cfg.moeda)}</span>
    </div>
    <div class="kpi red dp-owner-kpi">
      <span class="kpi-label">Despesas totais</span>
      <span class="kpi-value">${money(totalDespFiltrado, state.cfg.moeda)}</span>
    </div>
    <div class="kpi blue dp-owner-kpi">
      <span class="kpi-label">Saldo geral</span>
      <span class="kpi-value">${money(totalRecFiltrado-totalDespFiltrado, state.cfg.moeda)}</span>
    </div>
  `;

  if (!rows.length){
    containerLista.innerHTML = '<p class="muted">Nenhum funcionário encontrado.</p>';
    return;
  }

  // Ordenação
  if (usarRanking){
    rows.sort((a,b)=>b.faturamento - a.faturamento);
  } else {
    rows.sort((a,b)=>String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
  }

  containerLista.innerHTML = '';
  const lista = rowsFiltradas;
  if (!lista.length){
    containerLista.innerHTML = '<p class="muted">Nenhum dado financeiro encontrado para os filtros selecionados.</p>';
    return;
  }
  lista.forEach((r, idx)=>{
    const div = document.createElement('div');
    div.className = 'item dp-owner-item';
    div.innerHTML = `
      <strong>${escapeHtml(r.nome)}</strong>
      <div class="muted">Faturamento: ${money(r.faturamento, state.cfg.moeda)} • Despesas: ${money(r.despesas, state.cfg.moeda)} • Saldo: ${money(r.saldo, state.cfg.moeda)}</div>
    `;
    containerLista.appendChild(div);
  });
}

function renderAuditV4(){
  const box=$('#listaAuditV4'); if(!box) return; box.innerHTML='';
  if(!isPerfilAdmin(state.perfilId)){ box.innerHTML='<p class="muted">Disponível apenas para o administrador.</p>'; return; }
  const q=(($('#buscaAuditV4')&&$('#buscaAuditV4').value)||'').toLowerCase();
  (state.data.audit||[]).slice().sort((a,b)=>(b.at||'').localeCompare(a.at||'')).filter(x=>!q||((x.actorName||'')+(x.summary||'')+(x.entity||'')).toLowerCase().includes(q)).slice(0,200).forEach(x=>{ const d=document.createElement('div'); d.className='item'; const when=x.at?new Date(x.at).toLocaleString('pt-BR'):'—'; d.innerHTML=`<strong>${escapeHtml(x.actorName||'Usuário')} • ${escapeHtml(x.entity||'')}</strong><div>${escapeHtml(x.summary||'')}</div><div class="muted" style="font-size:11px">${escapeHtml(when)} • ${escapeHtml(x.action||'')}</div>`; box.appendChild(d); });
  if(!box.children.length) box.innerHTML='<p class="muted">Nenhum registro de auditoria encontrado.</p>';
}
function populateResponsaveisV4(){
  const sel=$('#agResponsavel'); if(!sel) return; const old=sel.value; sel.innerHTML=''; (state.perfis||[]).filter(p=>isPerfilAdmin(p.id)||isFuncionarioAtivo(p)).forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.nome||p.email||'Usuário';sel.appendChild(o);}); sel.value=old||getCurrentActorId();
}

function populateAgendaFiltersV5(){
  const sel=$('#agFiltroResponsavel'); if(!sel) return;
  const old=sel.value||'all'; sel.innerHTML='<option value="all">Todos os profissionais</option>';
  (state.perfis||[]).filter(p=>isPerfilAdmin(p.id)||isFuncionarioAtivo(p)).forEach(p=>{
    const o=document.createElement('option'); o.value=p.id; o.textContent=p.nome||p.email||'Usuário'; sel.appendChild(o);
  });
  sel.value=[...sel.options].some(o=>o.value===old)?old:'all';
}
// V5.1 - Melhorias 14/15: resumo financeiro no card e KPIs do Dashboard como atalhos.
function v51OpenTab(tab){
  // Navegação direta dos atalhos do Dashboard. Não dispara o clique do menu
  // lateral, pois esse clique também controla a abertura/fechamento do hambúrguer.
  const menu=document.querySelector('#navMenu .menu-item[data-tab="'+tab+'"]');
  if(!menu || menu.classList.contains('hidden')) return false;

  $$('#navMenu .menu-item').forEach(b=>b.classList.remove('active'));
  menu.classList.add('active');
  $$('.tabpane').forEach(p=>p.classList.remove('show'));
  const pane=$('#tab-'+tab);
  if(pane) pane.classList.add('show');

  // Atalhos nunca podem abrir o menu hambúrguer.
  const sidebar=$('#sidebar'), overlay=$('#overlay');
  if(sidebar) sidebar.classList.remove('open');
  if(overlay) overlay.classList.remove('show');

  // Mantém os mesmos efeitos necessários da navegação normal.
  if(tab==='agenda'){
    agEditId=null;
    const t=$('#agFormTitle'); if(t) t.textContent='Novo Agendamento';
    const btnAg=$('#btnAgendar'); if(btnAg) btnAg.textContent='Agendar Serviço';
    const tabAg=$('#tab-agenda'); if(tabAg) tabAg.classList.remove('edit-mode');
  }
  if(tab==='meu-usuario') renderMeuUsuario();
  return !!pane;
}
function v51DashboardAction(action){
  if(action==='clientes'){ v51OpenTab('clientes'); return; }
  if(action==='financeiro'){ v51OpenTab('financeiro'); return; }
  if(!v51OpenTab('agenda')) return;
  // Atalhos do Dashboard apenas levam à Agenda. Filtros só são aplicados
  // quando o usuário abre a busca e escolhe explicitamente um filtro.
  const status=$('#agFiltroStatus'), resp=$('#agFiltroResponsavel'), busca=$('#buscaAgenda');
  agendaFilter='all';
  if(status) status.value='all';
  if(resp) resp.value='all';
  if(busca) busca.value='';
  try{ updateAgendaFilterButtonsV51(); }catch(e){}
  renderAgenda();
}
function bindDashboardActionsV51(){
  if(window.__v51DashboardBound) return; window.__v51DashboardBound=true;
  const dash=$('#tab-dashboard'); if(!dash) return;
  dash.addEventListener('click',e=>{
    const card=e.target.closest('[data-v51-action]'); if(card){ v51DashboardAction(card.dataset.v51Action); return; }
    const q=e.target.closest('[data-dp-action]'); if(!q) return;
    const action=q.dataset.dpAction;
    if(action==='agenda'){ v51OpenTab('agenda'); return; }
    if(action==='novo-ag'){ v51OpenTab('agenda'); setTimeout(()=>{ const b=$('#btnAbrirNovoAgendamento'); if(b) b.click(); },0); return; }
    if(action==='novo-cliente'){ v51OpenTab('clientes'); setTimeout(()=>{ const b=$('#btnNovoCliente'); if(b) b.click(); },0); return; }
    if(action==='novo-servico'){ v51OpenTab('servicos'); setTimeout(()=>{ const b=$('#btnNovoServico'); if(b) b.click(); },0); return; }
    if(action==='relatorios'){ if(!v51OpenTab('visao-dono')) v51OpenTab('financeiro'); }
  });
  dash.addEventListener('keydown',e=>{ if((e.key==='Enter'||e.key===' ') && e.target.matches('[data-v51-action]')){ e.preventDefault(); v51DashboardAction(e.target.dataset.v51Action); } });
}
function renderDashboardV5(){
  const hoje=todayISO(); const agora=new Date(); const ym=hoje.slice(0,7);
  const addLocal=(iso,days)=>{ const [y,m,d]=iso.split('-').map(Number); const x=new Date(y,m-1,d); x.setDate(x.getDate()+days); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`; };
  const limite=addLocal(hoje,7);
  const agenda=Array.isArray(state.data.agenda)?state.data.agenda:[];
  const tx=Array.isArray(state.data.tx)?state.data.tx:[];
  const recHoje=tx.filter(t=>t.tipo==='receita' && t.data===hoje).reduce((n,t)=>n+Number(t.valor||0),0);
  const prox7=agenda.filter(a=>(a.data||'')>=hoje && (a.data||'')<=limite && (a.status||'agendado')!=='cancelado');
  const pendHoje=agenda.filter(a=>a.data===hoje && (a.status||'agendado')==='agendado').length;
  const conclMes=agenda.filter(a=>String(a.data||'').startsWith(ym) && (a.status||'')==='concluido').length;
  const dpNome=$('#dpNomeUsuario'); if(dpNome){ const nome=String(getCurrentActorName()||'Usuário').trim().split(/\s+/)[0]||'Usuário'; dpNome.textContent=nome; }
  const dpData=$('#dpDataHoje'); if(dpData){ const [yy,mm,dd]=hoje.split('-').map(Number); dpData.textContent=new Intl.DateTimeFormat('pt-BR',{weekday:'long',day:'numeric',month:'long'}).format(new Date(yy,mm-1,dd)); }
  if($('#stReceitaHoje')) $('#stReceitaHoje').textContent=money(recHoje,state.cfg.moeda);
  if($('#stProx7')) $('#stProx7').textContent=String(prox7.length);
  if($('#stPendHoje')) $('#stPendHoje').textContent=String(pendHoje);
  if($('#stConclMes')) $('#stConclMes').textContent=String(conclMes);

  const box=$('#dashProximosV5');
  if(box){ box.innerHTML=''; const upcoming=agenda.filter(a=>{ if((a.status||'agendado')==='cancelado'||!a.data) return false; const key=`${a.data}T${a.inicioHora||a.hora||'23:59'}`; return a.data>hoje || (a.data===hoje && key>=`${hoje}T${String(agora.getHours()).padStart(2,'0')}:${String(agora.getMinutes()).padStart(2,'0')}`); }).sort((a,b)=>`${a.data}${a.inicioHora||a.hora||''}`.localeCompare(`${b.data}${b.inicioHora||b.hora||''}`)).slice(0,6);
    if(!upcoming.length) box.innerHTML='<p class="muted">Nenhum atendimento próximo.</p>';
    upcoming.forEach(a=>{ const d=document.createElement('div'); d.className='item'; const st=(a.status||'agendado'); const stLabel=st==='concluido'?'Concluído':st==='cancelado'?'Cancelado':st==='agendado'?'Agendado':'Pendente'; d.innerHTML=`<div class="dp-appointment-row"><div class="dp-ap-time">${escapeHtml(a.inicioHora||a.hora||'—')}</div><div class="dp-ap-main"><strong>${escapeHtml(a.clienteNome||'Cliente')}</strong><span>${escapeHtml(a.servico||'Serviço')} • ${escapeHtml(a.responsavelNome||a.createdByName||'—')}</span></div><span class="dp-ap-status ${escapeHtml(st)}">${stLabel}</span></div>`; box.appendChild(d); });
  }
  const prof=$('#dashProfissionaisV5');
  if(prof){ prof.innerHTML=''; const map=new Map(); agenda.filter(a=>String(a.data||'').startsWith(ym) && (a.status||'agendado')!=='cancelado').forEach(a=>{ const key=a.responsavelUid||a.createdByUid||'sem'; const cur=map.get(key)||{nome:a.responsavelNome||a.createdByName||'Sem responsável',qtd:0,concl:0,valor:0}; cur.qtd++; if((a.status||'')==='concluido'){cur.concl++;cur.valor+=Number(a.valor||0);} map.set(key,cur); }); const rows=[...map.values()].sort((a,b)=>b.concl-a.concl||b.valor-a.valor).slice(0,8); if(!rows.length) prof.innerHTML='<p class="muted">Sem dados neste mês.</p>'; rows.forEach(r=>{ const d=document.createElement('div'); d.className='item'; d.innerHTML=`<div class="v5-dash-line"><div class="v5-dash-main"><strong>${escapeHtml(r.nome)}</strong><div class="muted v5-dash-meta">${r.concl} concluído(s) de ${r.qtd} atendimento(s)</div></div><span class="v5-dash-value">${money(r.valor,state.cfg.moeda)}</span></div>`; prof.appendChild(d); }); }
}

function refreshAll(){
  bindDashboardActionsV51();
  if(!window.__v5FiltersBound){ window.__v5FiltersBound=true; ['agFiltroStatus','agFiltroResponsavel'].forEach(id=>{const el=$('#'+id); if(el) el.addEventListener('change',renderAgenda);}); }
  renderMainCalendar();
  renderClientes();
  renderSelClientes('#agCliente');
  renderSelClientes('#anCliente');
  renderServicos();
  renderSelServicos('#agServicoSel');
  renderAgenda();
  renderAgendaResumo();
  renderTx();
  renderFiados();
  renderUsuarios();
  renderFuncionarios();
  renderVisaoDono();
  renderAuditV4();
  populateResponsaveisV4();
  populateAgendaFiltersV5();
  refreshKpis();
  refreshSystemStats();
  renderDashboardV5();
  // segurança aviso
  const perfil = state.perfis.find(p=>p.id===state.perfilId);
  if(perfil?.senhaHash){ $('#warnSenha').classList.add('hidden'); } else { $('#warnSenha').classList.remove('hidden'); }
}
function applyTheme(pref){
  const root = document.documentElement;
  let tema = pref || (state && state.cfg && state.cfg.tema) || 'auto';

  if(tema === 'auto'){
    let prefersDark = true;
    if(window.matchMedia){
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      prefersDark = mq.matches;
      if(!applyTheme._bound){
        const handler = () => {
          if((state.cfg.tema||'auto') === 'auto') applyTheme();
        };
        if(mq.addEventListener) mq.addEventListener('change', handler);
        else if(mq.addListener) mq.addListener(handler);
        applyTheme._bound = true;
      }
    }
    tema = prefersDark ? 'dark' : 'light';
  }

  root.setAttribute('data-theme', tema);
  root.style.setProperty('color-scheme', tema==='light' ? 'light dark' : 'dark');

  // Ajuste do 'vermelho' do app (ex: cancelados) para verde quando o tema verde estiver ativo
  try {
    if (state && state.cfg && state.cfg.cores) {
      const ca = String(state.cfg.cores.ca || '').toLowerCase();
      const isDefaultRed = (ca === '#ef4444' || ca === '#b91c1c' || ca === '#991b1b' || ca === '#ff0000');
      const isDefaultGreen = (ca === '#5dd62c');

      if (tema === 'green' && (isDefaultRed || !ca)) {
        state.cfg.cores.ca = '#5DD62C';
      }
      if (tema !== 'green' && isDefaultGreen) {
        state.cfg.cores.ca = '#EF4444';
      }

      document.documentElement.style.setProperty('--cor-ca', state.cfg.cores.ca);
      const corCaEl = document.getElementById('corCa');
      if (corCaEl) corCaEl.value = state.cfg.cores.ca;
    }
  } catch(e) { /* noop */ }
}



/* ======= LOGIN AUTOFILL ======= */
window.addEventListener('load', ()=>{
  // Cloud-first: não fazemos autofill baseado em perfis locais.
});


// Ajuste dinâmico de espaçamento para o cabeçalho fixo
document.addEventListener("DOMContentLoaded", function () {
  try {
    var header = document.querySelector(".app-header");
    var wrap = document.querySelector(".wrap");
    if (!header || !wrap) return;

    function applyHeaderPadding() {
      var h = header.offsetHeight || 0;
      // Mantém o padding lateral e inferior definidos no CSS,
      // ajustando apenas o padding-top para ficar logo abaixo do cabeçalho.
      wrap.style.paddingTop = h + "px";
    }

    applyHeaderPadding();
    window.addEventListener("resize", applyHeaderPadding);
  } catch (e) {
    console.error("Erro ao ajustar padding do cabeçalho fixo:", e);
  }
});


// ===== Config Modals (Notificações / Cores / Ações / Segurança) =====
function openCfgModal(id){
  const el = document.getElementById(id);
  if(!el) return;
  el.classList.remove('hidden');
}
function closeCfgModal(id){
  const el = document.getElementById(id);
  if(!el) return;
  el.classList.add('hidden');
}
function initCfgModals(){
  document.querySelectorAll('[data-open]').forEach(btn=>{
    btn.addEventListener('click', ()=> openCfgModal(btn.getAttribute('data-open')));
  });
  document.querySelectorAll('[data-close]').forEach(btn=>{
    btn.addEventListener('click', ()=> closeCfgModal(btn.getAttribute('data-close')));
  });
}

// ensure init runs
document.addEventListener('DOMContentLoaded', initCfgModals);
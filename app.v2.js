
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
      refreshDbStatus();
    }
  }catch(e){ console.error(e); }
}

async function backupToFirebase(){
  try{
    if(!window.db || !state || !state.perfilId) return;
    const ref = db.collection('perfis').doc(String(state.perfilId));
    await ref.set({
      data: state.data||{},
      cfg: state.cfg||{},
      updatedAt: new Date().toISOString()
    },{merge:true});
  }catch(e){ console.error(e);}
}

async function restaurarDoFirebase(pid){
  try{
    const ref=db.collection('perfis').doc(String(pid));
    const snap=await ref.get();
    return snap.exists ? snap.data() : null;
  }catch(e){ console.error(e); return null;}
}

/* ======= UTIL ======= */
const $ = (sel, ctx=document)=>ctx.querySelector(sel);
const $$ = (sel, ctx=document)=>Array.from(ctx.querySelectorAll(sel));
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
    box.style.color = '#f97373';
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
  cfg: {estudio:'Studio LH', moeda:'BRL', tema:'auto', logoBase64:null,
        wpp24:true, wpp2:true, autoBackup:false,
        msgWpp:'Olá! Lembrando do seu horário em {{DATA}} ({{HORA}}).' ,
        msgWppConcluido:'Obrigado por fechar com a gente em {{DATA}} ({{HORA}})! Qualquer dúvida sobre os cuidados é só chamar.',
        msgWppCancelado:'Seu horário de {{SERVICO}} em {{DATA}} ({{HORA}}) foi cancelado. Se quiser remarcar é só responder aqui.',
        pixChave:'',
        cores:{ag:'#3b82f6', co:'#22c55e', ca:'#ef4444'},
        senhaHash:'' },
  data: {clientes:[], servicos:[], agenda:[], tx:[], an:[], usuarios:[], backups:[], lastLogin:''}
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
  return perfis.length > 0 && perfis[0].id === perfil.id;
}

// Retorna o objeto do perfil atualmente logado
function getPerfilAtual(){
  return (state.perfis || []).find(p => p.id === state.perfilId) || null;
}


function setMeuUsuarioMessage(msg, isError = true) {
  const box = document.getElementById('meuUsuarioMsg');
  if (!box) return;
  box.textContent = msg || '';
  if (!msg) return;
  box.style.color = isError ? '#f97373' : '#4ade80';
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

  const usuariosTab = document.querySelector('#tab-usuarios');
  const usuariosMenuItem = document.querySelector('#navMenu .menu-item[data-tab="usuarios"]');

  if (isAdmin){
    if (usuariosTab) usuariosTab.classList.remove('hidden');
    if (usuariosMenuItem) usuariosMenuItem.classList.remove('hidden');
  } else {
    if (usuariosTab) usuariosTab.classList.add('hidden');
    if (usuariosMenuItem) usuariosMenuItem.classList.add('hidden');
  }
}
const LS_KEY = 'studioLH__perfis';             // índice de perfis
const NS = (pid) => `studioLH__${pid}__data`;  // namespace por perfil
const CFG = (pid) => `studioLH__${pid}__cfg`;

/* ======= STORAGE ======= */
function loadPerfis(){
  state.perfis = JSON.parse(localStorage.getItem(LS_KEY)||'[]');
  renderPerfis();
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
function savePerfis(){ localStorage.setItem(LS_KEY, JSON.stringify(state.perfis)); }
function ensurePerfilData(pid){
  if(!localStorage.getItem(NS(pid))){
    localStorage.setItem(NS(pid), JSON.stringify({clientes:[],servicos:[],agenda:[],tx:[],an:[],usuarios:[],backups:[], lastLogin:''}));
    localStorage.setItem(CFG(pid), JSON.stringify(state.cfg));
  }
}
function loadPerfil(pid){
  state.perfilId = pid; ensurePerfilData(pid);
  state.data = JSON.parse(localStorage.getItem(NS(pid)));
  state.cfg  = Object.assign({}, state.cfg, JSON.parse(localStorage.getItem(CFG(pid))));

  applyTheme(state.cfg.tema);
  // aplicar UI config
  $('#cfgEstudio').value = state.cfg.estudio||'';
  $('#cfgMoeda').value   = state.cfg.moeda||'BRL';
  $('#cfgTema').value    = state.cfg.tema||'auto';
  $('#cfgWpp24').checked = !!state.cfg.wpp24;
  $('#cfgWpp2').checked  = !!state.cfg.wpp2;
  $('#cfgAutoBackup').checked = !!state.cfg.autoBackup;
  $('#cfgMsgWpp').value = state.cfg.msgWpp||'';
  if ($('#cfgMsgWppConcluido')) $('#cfgMsgWppConcluido').value = state.cfg.msgWppConcluido||'';
  if ($('#cfgMsgWppCancelado')) $('#cfgMsgWppCancelado').value = state.cfg.msgWppCancelado||'';
  if ($('#cfgPixChave')) $('#cfgPixChave').value = state.cfg.pixChave||'';
  $('#corAg').value = state.cfg.cores.ag; $('#corCo').value = state.cfg.cores.co; $('#corCa').value = state.cfg.cores.ca;
  document.documentElement.style.setProperty('--cor-ag', state.cfg.cores.ag);
  document.documentElement.style.setProperty('--cor-co', state.cfg.cores.co);
  document.documentElement.style.setProperty('--cor-ca', state.cfg.cores.ca);

  document.body.classList.remove('only-login');
  const userBoxEl = $('#userBox');
  if (userBoxEl) userBoxEl.classList.remove('hidden');
  const perfilAtual = getPerfilAtual();
  const userRoleEl = $('#userRole');
  if (userRoleEl) userRoleEl.textContent = isPerfilAdmin(state.perfilId) ? 'Administrador' : 'Funcionário';
  renderMeuUsuario();
  renderSidebarPerfil();
  $('#loginCard').classList.add('hidden');
  $('#sidebar').classList.remove('hidden'); // Exibe o menu lateral após o login
  // Exibe a aba inicial (Agenda)
  $('#tab-agenda').classList.add('show');
  // A navegação agora é feita pelo menu lateral, não precisa mais do #nav
  // $('#nav').classList.remove('hidden');

  // Aplica regras de permissão (mostra/esconde aba Usuários, etc.)
  aplicarPermissoesPerfil();

  state.data.lastLogin = new Date().toISOString();
  savePerfil();

  refreshAll();
  refreshSystemStats();
  refreshDbStatus();
  autoBackupIfNeeded();
}
function savePerfil(){
  localStorage.setItem(NS(state.perfilId), JSON.stringify(state.data));
  localStorage.setItem(CFG(state.perfilId), JSON.stringify(state.cfg));
  if(window.db) backupToFirebase();
}

/* ======= HASH (simples) ======= */
const simpleHash = (s)=> btoa(unescape(encodeURIComponent(s))).split('').reverse().join('');

/* ======= INICIAL ======= */
document.addEventListener('DOMContentLoaded', init);
function init(){
  // Aplica o tema salvo no primeiro perfil (se existir) antes de montar a UI
  let temaBase = 'auto';
  try {
    const perfisSalvos = JSON.parse(localStorage.getItem(LS_KEY)||'[]');
    if (perfisSalvos.length > 0) {
      const pid0 = perfisSalvos[0].id;
      const cfgRaw = localStorage.getItem(CFG(pid0));
      if (cfgRaw) {
        const cfg = JSON.parse(cfgRaw);
        temaBase = cfg.tema || 'auto';
      }
    }
  } catch(e){ /* ignora erro e mantém auto */ }
  applyTheme(temaBase);

  loadPerfis();
  if(state.perfis.length===0){
    const id = uid();
    state.perfis.push({id, nome:'👑 Administrador (Proprietário)', senhaHash:'', isAdmin:true});
    savePerfis();
  }
  renderPerfis();
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

  const saldoBar = document.getElementById('saldoBar');
  const btnToggleSaldo = document.getElementById('btnToggleSaldo');
  if (saldoBar && btnToggleSaldo) {
    btnToggleSaldo.addEventListener('click', () => {
      saldoBar.classList.toggle('hidden');
    });
  }


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
  $('#agImagem').addEventListener('change', previewImagem);

  $('#openReceita').onclick = ()=>openFormTx('receita');
  $('#openDespesa').onclick = ()=>openFormTx('despesa');
  $('#btnCloseTx').onclick = ()=>$('#formTransacao').classList.add('hidden');
  $('#btnAddTx').onclick = addTransacao;

  $('#btnAddCliente').onclick = addCliente;

  const btnNovoCliente = $('#btnNovoCliente');
  if (btnNovoCliente) {
    btnNovoCliente.onclick = ()=>{
      // Abre a tela dedicada de cadastro de cliente
      $('#clNome').value=''; $('#clEmail').value=''; $('#clZap').value=''; $('#clEnd').value='';
      $('#btnAddCliente').textContent='Cadastrar Cliente';
      $('#btnAddCliente').onclick = addCliente;
      if (typeof abrirCadastroCliente === 'function') abrirCadastroCliente();
      $('#clNome').focus();
    };
  }

  const btnVoltarClientes = $('#btnVoltarClientes');
  if (btnVoltarClientes) {
    btnVoltarClientes.onclick = ()=>{
      // Volta para a lista de clientes e reseta o formulário
      $('#clNome').value=''; $('#clEmail').value=''; $('#clZap').value=''; $('#clEnd').value='';
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

  $('#btnSalvarAn').onclick = salvarAnamnese;
  $$('#tab-anamnese .btn.model').forEach(b=>b.onclick = ()=>gerarModelo(b.dataset.modelo));

  $('#btnExportar').onclick = exportarDados;
  $('#fileImport').addEventListener('change', importarDados);
  $('#btnBackup').onclick = backupManual;
  $('#btnRecuperar').onclick = recuperarUltimo;
  $('#btnRelatorio').onclick = exportarRelatorio;
  if ($('#btnExportAgenda')) $('#btnExportAgenda').onclick = exportAgendaCSV;
  if ($('#btnRelatorioAgendaPdf')) $('#btnRelatorioAgendaPdf').onclick = gerarRelatorioAgendaPdf;
  if ($('#btnExportTx')) $('#btnExportTx').onclick = exportTxCSV;

  $$('.ag-filtros-rapidos [data-ag-filter]').forEach(btn=>{
    btn.onclick = ()=>{
      agendaFilter = btn.dataset.agFilter;
      renderAgenda();
    };
  });

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
      }

      if(id === 'meu-usuario'){
        renderMeuUsuario();
      }

      toggleSidebar(); // Fecha o menu após a seleção
    };
  });
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


function integrarUsuarioAoSistema(userEmail) {
  const emailLower = (userEmail || '').toLowerCase();

  if (!state.perfis || state.perfis.length === 0) {
    const id = uid();
    state.perfis.push({ id, nome:'👑 Administrador (Proprietário)', email: emailLower, senhaHash:'', isAdmin:true });
    savePerfis();
  }

  const perfis = state.perfis || [];

  let perfil = perfis.find(p => (p.email || '').toLowerCase() === emailLower);

  if (!perfil) {
    const adminSemEmail = perfis.find(p => isPerfilAdmin(p.id) && !p.email);
    if (adminSemEmail) {
      adminSemEmail.email = emailLower;
      savePerfis();
      perfil = adminSemEmail;
    }
  }

  if (!perfil) {
    setAuthMessage('Seu e-mail não está vinculado a um funcionário neste sistema. Peça ao administrador para criar seu usuário.');
    if (auth) auth.signOut();
    return;
  }

  // Lembrar e-mail (opcional) se checkbox estiver marcado
  const rememberEl = document.getElementById('rememberLogin');
  if (rememberEl && rememberEl.checked) {
    try {
      localStorage.setItem('studioLH__remember_email', emailLower);
    } catch(e) {}
  } else {
    try {
      localStorage.removeItem('studioLH__remember_email');
    } catch(e) {}
  }

  setAuthMessage('');
  loadPerfil(perfil.id);
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

    // Cria um novo perfil administrador para este e-mail
    const id = uid();
    state.perfis = state.perfis || [];
    state.perfis.push({
      id,
      nome: '👑 Administrador',
      email: emailLower,
      senhaHash: '',
      isAdmin: true
    });
    savePerfis();

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

      await secondaryAuth.createUserWithEmailAndPassword(email, senha);

      const id = uid();
      const novoPerfil = {
        id,
        nome,
        email,
        senhaHash: '',
        isAdmin: false,
        cargo,
        setor,
        situacao
      };

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
  const funcionarios = (state.perfis || []).filter(p => !isPerfilAdmin(p.id));

  if(funcionarios.length === 0){
    box.innerHTML = '<p class="muted">Nenhum funcionário cadastrado.</p>';
    return;
  }

  funcionarios.forEach(p=>{
    const situacao = p.situacao === 'inativo' ? 'inativo' : 'ativo';
    const situacaoLabel = situacao === 'ativo' ? 'Ativo' : 'Inativo';
    const badgeClass = situacao === 'ativo' ? 'badge-success' : 'badge-muted';
    const cargo = p.cargo || '';
    const setor = p.setor || '';

    const div = document.createElement('div');
    div.className='item row';
    div.innerHTML = `
      <div class="flex1">
        <strong>${p.nome || '-'}</strong>
        <div class="muted">
          ${cargo ? cargo : 'Cargo não informado'}
          ${setor ? ' • ' + setor : ''}
        </div>
      </div>
      <div class="flex1" style="display:flex;flex-direction:column;gap:4px;align-items:flex-start;">
        <span class="muted">${p.email || '-'}</span>
        <span class="badge ${badgeClass}">${situacaoLabel}</span>
      </div>
      <button class="btn danger sm" onclick="removerFuncionario('${p.id}')">Remover</button>
    `;
    box.appendChild(div);
  });
}
function removerFuncionario(id){
  if (!isPerfilAdmin(state.perfilId)) {
    alert('Apenas o administrador pode remover funcionários.');
    return;
  }

  if(!confirm('Tem certeza que deseja remover este funcionário? Todos os dados dele serão perdidos.')) return;

  // 1. Remover o perfil da lista principal
  state.perfis = state.perfis.filter(p => p.id !== id);
  savePerfis();

  // 2. Remover os dados do localStorage (dados do perfil e config)
  localStorage.removeItem(NS(id));
  localStorage.removeItem(CFG(id));

  // 3. Atualizar a UI
  renderPerfis();
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


  renderFuncionarios();
  renderUsuarios();
  alert('Funcionário removido com sucesso.');
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

function previewImagem(evt){
  const file = evt.target.files[0];
  if(!file) return $('#agPreview').classList.add('hidden');
  const reader = new FileReader();
  reader.onload = e=>{
    $('#agPreview').innerHTML = `<img src="${e.target.result}" alt="preview">`;
    $('#agPreview').classList.remove('hidden');
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
    img: $('#agPreview img') ? $('#agPreview img')?.src : ''
  };

  // Verifica conflitos de horário simples
  const parseMinutes = (h) => {
    if(!h) return null;
    const [hh,mm] = h.split(':').map(Number);
    return hh*60 + (mm||0);
  };

  const novoIni = parseMinutes(inicioHora);
  const novoFim = fimHora ? parseMinutes(fimHora) : novoIni;

  const hasConflito = state.data.agenda.some(x=>{
    if(x.data !== obj.data) return false;
    if(x.id === obj.id) return false;
    if(x.diaInteiro || obj.diaInteiro) return true;
    const xIni = parseMinutes(x.inicioHora || x.hora);
    const xFim = x.fimHora ? parseMinutes(x.fimHora) : xIni;
    if(xIni==null || novoIni==null) return false;
    return Math.max(xIni, novoIni) < Math.min(xFim, novoFim);
  });

  if(hasConflito){
    const ok = confirm('Já existe um agendamento nesse horário ou que sobrepõe esse período. Deseja continuar mesmo assim?');
    if(!ok) return;
  }

  if(existing){
    Object.assign(existing, obj);
  } else {
    state.data.agenda.push(obj);
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
  $('#agImagem').value='';
  $('#agPreview').classList.add('hidden');

  renderAgenda();
  renderMainCalendar(); // Atualiza o calendário principal para mostrar o novo agendamento
}
function delAgendamento(id){
  state.data.agenda = state.data.agenda.filter(a=>a.id!==id);
  savePerfil(); renderAgenda();
  renderMainCalendar(); // Atualiza o calendário principal para remover o agendamento
}

function editAgendamento(id){
  const a = state.data.agenda.find(x=>x.id===id);
  if(!a) return;

  agEditId = id;

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

  // Preview da imagem
  if(a.img){
    $('#agPreview').innerHTML = `<img src="${a.img}" alt="preview">`;
    $('#agPreview').classList.remove('hidden');
  }else{
    $('#agPreview').innerHTML = '';
    $('#agPreview').classList.add('hidden');
  }

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

function txFromAgendamento(id){
  const a = state.data.agenda.find(x=>x.id===id);
  if(!a) return;
  // A navegação agora é feita pelo menu lateral, não precisa mais do #nav
  $$('.tabpane').forEach(p=>p.classList.remove('show')); $('#tab-financeiro').classList.add('show');
  // Ativar o item do menu lateral "Financeiro"
  $$('#navMenu .menu-item').forEach(b=>b.classList.remove('active'));
  $$('#navMenu .menu-item[data-tab="financeiro"]')[0].classList.add('active');
  openFormTx('receita');
  $('#txDesc').value = `Serviço: ${a.servico} • Cliente: ${a.clienteNome}`;
  $('#txValor').value = (a.valor||0).toFixed(2).replace('.',',');
  $('#txData').value = a.data;
  $('#txCat').value = 'Serviços';
  // Adicionar a transação automaticamente
  addTransacao();
}

function renderAgenda(){
  const buscaEl = $('#buscaAgenda');
  const q = (buscaEl && buscaEl.value ? buscaEl.value : '').toLowerCase();
  const box = $('#listaAgenda');
  if (!box || !state || !state.data || !Array.isArray(state.data.agenda)) return;

  box.innerHTML = '';

  (state.data.agenda || [])
    .slice()
    .sort((a,b)=> (a.data||'').localeCompare(b.data||'') || (a.hora||'').localeCompare(b.hora||''))
    .filter(a=>{
      const texto = ((a.servico||'') + (a.obs||'') + (a.clienteNome||'')).toLowerCase();
      const dataBr = (a.dataBr || (a.data ? a.data.split('-').reverse().join('/') : '')).toLowerCase();
      return !q || texto.includes(q) || dataBr.includes(q);
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
        const amanhaISO = amanha.toISOString().slice(0,10);
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
      const statusLabel = (a.status || 'agendado').toUpperCase();

      div.innerHTML = `
        <div class="ag-grid">
          <div class="ag-row">
            <div class="ag-col">
              <div class="ag-label">Cliente</div>
              <div class="ag-text ag-cliente">${a.clienteNome}</div>
            </div>
            <div class="ag-col">
              <div class="ag-label">Data / Hora</div>
              <div class="ag-text ag-datahora">${dataLabel}${horarioLabel ? ' • ' + horarioLabel : ''}</div>
            </div>
          </div>
          <div class="ag-row">
            <div class="ag-col">
              <div class="ag-label">Serviço</div>
              <div class="ag-text ag-servico">${a.servico}</div>
            </div>
            <div class="ag-col">
              <div class="ag-label">Valor</div>
              <div class="ag-text ag-valor">${money(a.valor, state.cfg.moeda)}</div>
            </div>
            <div class="ag-col ag-col-status">
              <div class="ag-label">Status</div>
              <div class="ag-status-tag ag-status-${a.status || 'agendado'}">${statusLabel}</div>
            </div>
          </div>
        </div>
        ${a.img ? `<img class="image" src="${a.img}"/>` : ''}

        <div class="row ag-actions" style="margin-top:6px;gap:8px">
          <div class="ag-actions-main">
            <button class="btn ghost xs ag-btn" data-id="${a.id}" data-act="wpp">
              <i class="fa-brands fa-whatsapp"></i>
              <span>Lembrete</span>
            </button>
            <button class="btn ghost xs ag-btn" data-id="${a.id}" data-act="tx">
              <span>Financeiro</span>
            </button>
          </div>
          <div class="ag-actions-secondary">
            <button class="btn ghost xs ag-btn" data-id="${a.id}" data-act="edit">
              <i class="fa-solid fa-pen"></i>
              <span>Editar</span>
            </button>
            <button class="btn danger xs ag-btn" data-id="${a.id}" data-act="del">
              <span>Excluir</span>
            </button>
          </div>
        </div>
        `;

      box.appendChild(div);
    });

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
    dataBr: new Date($('#txData').value || Date.now()).toLocaleDateString('pt-BR'),
    cat: $('#txCat').value
  };
  if(!obj.data) return alert('Informe a data.');
  state.data.tx.push(obj);
  savePerfil();
  $('#formTransacao').classList.add('hidden');
  $('#txDesc').value=''; $('#txValor').value='0,00';
  renderTx();
}
function delTx(id){ state.data.tx = state.data.tx.filter(t=>t.id!==id); savePerfil(); renderTx(); }
function editTx(id){
  const t = state.data.tx.find(x=>x.id===id); if(!t) return;
  openFormTx(t.tipo);
  $('#txDesc').value=t.desc; $('#txValor').value=t.valor.toFixed(2).replace('.',',');
  $('#txData').value=t.data; $('#txCat').value=t.cat;
  $('#btnAddTx').onclick = ()=>{
    t.tipo=$('#txTipo').value; t.desc=$('#txDesc').value.trim();
    t.valor=parseMoney($('#txValor').value); t.data=$('#txData').value; t.dataBr=new Date(t.data).toLocaleDateString('pt-BR');
    t.cat=$('#txCat').value; savePerfil(); $('#formTransacao').classList.add('hidden'); renderTx();
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
      div.className='item';
      div.innerHTML = `
        <strong>${t.tipo.toUpperCase()} • ${t.dataBr} — ${money(t.valor, state.cfg.moeda)}</strong>
        <div class="muted">${t.cat} — ${t.desc||''}</div>
        <div class="row" style="margin-top:6px;gap:8px">
          <button class="btn ghost sm" data-id="${t.id}" data-act="edit">Editar</button>
          <button class="btn danger sm" data-id="${t.id}" data-act="del">Excluir</button>
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
  $('#saldoTopo').textContent = money(saldo, state.cfg.moeda);
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
    end: $('#clEnd').value.trim()
  };
  state.data.clientes.push(obj);
  savePerfil();
  $('#clNome').value=''; $('#clEmail').value=''; $('#clZap').value=''; $('#clEnd').value='';
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

  $('#clNome').value=c.nome; $('#clEmail').value=c.email; $('#clZap').value=c.zap; $('#clEnd').value=c.end;
  $('#btnAddCliente').textContent='Salvar Alterações';

  const originalOnClick = $('#btnAddCliente').onclick;

  $('#btnAddCliente').onclick = ()=>{
    c.nome=$('#clNome').value.trim(); c.email=$('#clEmail').value.trim();
    c.zap=$('#clZap').value.trim(); c.end=$('#clEnd').value.trim();
    savePerfil(); renderClientes(); 
    if (typeof voltarListaClientes === 'function') voltarListaClientes();

    $('#btnAddCliente').textContent='Cadastrar Cliente';
    $('#btnAddCliente').onclick = originalOnClick;

    $('#clNome').value=''; $('#clEmail').value=''; $('#clZap').value=''; $('#clEnd').value='';
  };
}

function renderClientes(){
  const q = ($('#buscaCliente').value||'').toLowerCase();
  const box = $('#listaClientes'); box.innerHTML='';
  state.data.clientes
    .filter(c=>!q || c.nome.toLowerCase().includes(q))
    .forEach(c=>{
      const div = document.createElement('div');
      div.className='item';
      div.innerHTML = `
        <strong>${c.nome}</strong>
        <div class="muted">${c.email||'—'} • ${c.zap||'—'}</div>
        <div class="muted sm">${c.end||' '}</div>
        <div class="row" style="gap:8px;margin-top:6px">
          <button class="btn ghost sm" data-id="${c.id}" data-act="edit">Editar</button>
          <button class="btn danger sm" data-id="${c.id}" data-act="del">Excluir</button>
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
      div.className='item';
      div.innerHTML = `
        <div class="row" style="justify-content:space-between;align-items:center;gap:12px;">
          <div class="flex1">
            <strong>${s.nome}</strong>
            <div class="muted">
              <strong>Preço:</strong> ${money(s.preco, state.cfg.moeda)}&nbsp;•&nbsp;
              <strong>Duração:</strong> ${(s.duracaoMin || 0)} min
            </div>
          </div>
          <div class="row" style="gap:8px;">
            <button class="btn ghost sm" data-id="${s.id}" data-act="edit">Editar</button>
            <button class="btn danger sm" data-id="${s.id}" data-act="del">Excluir</button>
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
}
function preencherValorServico(){
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
const MODELOS = {
  basico: ['Alergia a medicamentos?','Doenças pré-existentes?','Uso de anticoagulantes?','Cicatrização lenta?','Já fez tatuagem antes?'],
  completo: ['Idade','Medicamentos em uso','Alergias','Diabetes/Hipertensão','Gestante/Lactante','Problemas dermatológicos','Queloide','Fuma/Álcool','Assina termo?'],
  detalhado:['Altura','Peso','IMC (aprox.)','Pressão recente','Cirurgias','Cicatriz/Queloide','Tendência a sangramento','Avaliação da pele','Consentimento informado']
};
function gerarModelo(key){
  const campos = MODELOS[key]||MODELOS.basico;
  $('#anCampos').innerHTML = '';
  campos.forEach(p=>{
    const div = document.createElement('div');
    div.innerHTML = `<label class="label">${p}</label><input class="input" data-pergunta="${p}" />`;
    $('#anCampos').appendChild(div);
  });
  $('#anCampos').dataset.modelo = key;
}
function salvarAnamnese(){
  const idc = $('#anCliente').value;
  const cliente = state.data.clientes.find(c=>c.id===idc);
  if(!cliente) return alert('Selecione um cliente.');
  const modelo = $('#anCampos').dataset.modelo || 'basico';
  const respostas = $$('input[data-pergunta]', $('#anCampos')).map(i=>({p:i.dataset.pergunta,v:i.value.trim()}));
  const obj = { id:uid(), clienteId:idc, clienteNome:cliente.nome, modelo,
                respostas, data: new Date().toISOString(),
                dataBr: new Date().toLocaleDateString('pt-BR') };
  state.data.an.push(obj); savePerfil();
  $('#anCampos').innerHTML=''; renderAn();
}
function renderAn(){
  const q = ($('#buscaAn').value||'').toLowerCase();
  const box = $('#listaAn'); box.innerHTML='';
  state.data.an
    .slice().sort((a,b)=>b.data.localeCompare(a.data))
    .filter(a=>!q || (a.clienteNome||'').toLowerCase().includes(q))
    .forEach(a=>{
      const div = document.createElement('div');
      div.className='item';
      div.innerHTML = `
        <strong>${a.dataBr} • ${a.clienteNome} — ${a.modelo.toUpperCase()}</strong>
        <pre class="muted" style="white-space:pre-wrap">${a.respostas.map(r=>`• ${r.p}: ${r.v}`).join('\n')}</pre>
        <div class="row" style="gap:8px">
          <button class="btn ghost sm" data-id="${a.id}" data-act="export">Exportar</button>
          <button class="btn danger sm" data-id="${a.id}" data-act="del">Excluir</button>
        </div>`;
      box.appendChild(div);
    });
  $$('#listaAn [data-act="del"]').forEach(b=>b.onclick=()=>{state.data.an=state.data.an.filter(x=>x.id!==b.dataset.id); savePerfil(); renderAn();});
  $$('#listaAn [data-act="export"]').forEach(b=>b.onclick=()=>exportSingle('anamnese', state.data.an.find(x=>x.id===b.dataset.id)));
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
      a.dataBr || (a.data ? new Date(a.data).toLocaleDateString('pt-BR') : ''),
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
      t.dataBr || (t.data ? new Date(t.data).toLocaleDateString('pt-BR') : ''),
      t.tipo || '',
      t.desc || '',
      t.cat || '',
      money(t.valor||0, state.cfg.moeda)
    ]);
  });
  downloadCSV('financeiro.csv', rows);
}
function backupManual(){
  const payload = {date:new Date().toISOString(), data:structuredClone(state.data), cfg:structuredClone(state.cfg)};
  state.data.backups.unshift(payload);
  // manter últimos 10
  state.data.backups = state.data.backups.slice(0,10);
  savePerfil(); alert('Backup criado.');
}
function recuperarUltimo(){
  const b = state.data.backups?.[0];
  if(!b) return alert('Sem backups disponíveis.');
  if(!confirm('Restaurar o último backup? Isto substituirá os dados atuais.')) return;
  state.data = b.data; state.cfg = b.cfg; savePerfil(); refreshAll(); alert('Restaurado com sucesso!');
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
      <div class="row"><button class="btn ghost sm" data-i="${idx}" data-act="rest">Restaurar</button></div>`;
    list.appendChild(d);
  });
  $$('#listaBackups [data-act="rest"]').forEach(b=>b.onclick=()=>{
    const i=+b.dataset.i; if(!confirm('Restaurar este backup?')) return;
    state.data = state.data.backups[i].data; state.cfg = state.data.backups[i].cfg; savePerfil(); refreshAll(); alert('Backup restaurado.');
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
  const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='relatorio_studioLH.txt'; a.click();
}
function refreshSystemStats(){
  $('#stClientes').textContent = state.data.clientes.length;
  const hoje = todayISO();
  $('#stHoje').textContent = state.data.agenda.filter(a=>a.data===hoje).length;
  const ym = new Date().toISOString().slice(0,7);
  const recMes = state.data.tx.filter(t=>t.tipo==='receita' && t.data.startsWith(ym)).reduce((s,t)=>s+t.valor,0);
  $('#stMes').textContent = money(recMes, state.cfg.moeda);
  $('#stTx').textContent = state.data.tx.length;
}

/* ======= CONFIG / AÇÕES ======= */
function salvarCfg(){
  state.cfg.estudio = $('#cfgEstudio').value.trim()||'Studio LH';
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
  alert('Configurações salvas.');
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
  state.data = {clientes:[], servicos:[], agenda:[], tx:[], an:[], usuarios:[], backups:[], lastLogin:state.data.lastLogin};
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
  if(isNewDay) backupManual();
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
          <div class="agenda-resumo-cliente">${nome}</div>
          <div class="agenda-resumo-dia-linha">${dataBr}</div>
          <div class="agenda-resumo-hora">${linhaHorario}</div>
          <div class="agenda-resumo-detalhe-horas">${detalheHoras}</div>
          <div class="agenda-resumo-descricao">${descricao || ''}</div>
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
    const base = new Date(currentResumoDateISO);
    const next = new Date(base);
    next.setDate(base.getDate() + offset);
    const nextISO = next.toISOString().slice(0, 10);

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


function renderVisaoDono(){
  const containerResumo = document.getElementById('visaoDonoResumo');
  const containerLista = document.getElementById('visaoDonoLista');
  if (!containerResumo || !containerLista) return;

  const perfilAtual = getPerfilAtual();
  if (!perfilAtual || !isPerfilAdmin(perfilAtual.id)) {
    // Se não for admin, limpa e esconde info
    containerResumo.innerHTML = '';
    containerLista.innerHTML = '<p class="muted">Apenas o administrador tem acesso a esta visão.</p>';
    return;
  }

  const perfis = state.perfis || [];
  const rows = [];

  let totalGeralReceitas = 0;
  let totalGeralDespesas = 0;

  perfis.forEach(p => {
    // cada perfil tem seu próprio namespace de dados no localStorage
    try {
      const nsKey = NS(p.id);
      const raw = localStorage.getItem(nsKey);
      if (!raw) return;
      const dados = JSON.parse(raw);

      const tx = dados.tx || [];
      const rec = tx.filter(t=>t.tipo==='receita').reduce((s,t)=>s+(t.valor||0),0);
      const desp = tx.filter(t=>t.tipo==='despesa').reduce((s,t)=>s+(t.valor||0),0);
      const saldo = rec - desp;

      totalGeralReceitas += rec;
      totalGeralDespesas += desp;

      rows.push({
        id: p.id,
        nome: p.nome,
        receitas: rec,
        despesas: desp,
        saldo
      });
    } catch(e){
      console.error('Erro ao carregar dados do perfil para visão do dono', p.id, e);
    }
  });

  // monta resumos
  containerResumo.innerHTML = `
    <div class="kpi green">
      <span class="kpi-label">Receitas totais</span>
      <span class="kpi-value">${money(totalGeralReceitas, state.cfg.moeda)}</span>
    </div>
    <div class="kpi red">
      <span class="kpi-label">Despesas totais</span>
      <span class="kpi-value">${money(totalGeralDespesas, state.cfg.moeda)}</span>
    </div>
    <div class="kpi blue">
      <span class="kpi-label">Saldo geral</span>
      <span class="kpi-value">${money(totalGeralReceitas-totalGeralDespesas, state.cfg.moeda)}</span>
    </div>
  `;

  if (!rows.length){
    containerLista.innerHTML = '<p class="muted">Nenhum dado financeiro encontrado para os perfis.</p>';
    return;
  }

  // ordena por saldo (maior para menor)
  rows.sort((a,b)=>b.saldo - a.saldo);

  containerLista.innerHTML = '';
  rows.forEach(r=>{
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <strong>${r.nome}</strong>
      <div class="muted sm">ID: ${r.id}</div>
      <div class="muted">Receitas: ${money(r.receitas, state.cfg.moeda)} • Despesas: ${money(r.despesas, state.cfg.moeda)} • Saldo: ${money(r.saldo, state.cfg.moeda)}</div>
    `;
    containerLista.appendChild(div);
  });
}

function refreshAll(){
  renderMainCalendar();
  renderClientes();
  renderSelClientes('#agCliente');
  renderSelClientes('#anCliente');
  renderServicos();
  renderSelServicos('#agServicoSel');
  renderAgenda();
  renderAgendaResumo();
  renderTx();
  renderUsuarios();
  renderFuncionarios();
  renderVisaoDono();
  refreshKpis();
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
}



/* ======= LOGIN AUTOFILL ======= */
window.addEventListener('load', ()=>{
  const perfis = JSON.parse(localStorage.getItem(LS_KEY)||'[]');
  const sel = $('#selPerfil');
  if(perfis.length===1 && sel){ sel.value = perfis[0].id; }
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

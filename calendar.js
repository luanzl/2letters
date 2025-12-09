
// calendar.js — calendário compacto + expansão para mês

const getFirstDayOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1);
const getLastDayOfMonth  = (date) => new Date(date.getFullYear(), date.getMonth() + 1, 0);

/**
 * Renderiza o calendário principal.
 * @param {string} containerId  ID do elemento container.
 * @param {Date}   initialDate  Data inicial selecionada.
 * @param {fn}     onDateSelect Callback(dateISO) quando o dia é clicado.
 * @param {Array}  agendamentos Lista de agendamentos (precisa ter .data e .status).
 */
function renderCalendar(containerId, initialDate, onDateSelect, agendamentos) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const safeOnDateSelect = typeof onDateSelect === 'function' ? onDateSelect : () => {};

  // ISO (YYYY-MM-DD) do dia de hoje em horário local (sem UTC/ISO shift)
  const todayLocalISO = (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  })();


  // Função auxiliar para construir Date local a partir de YYYY-MM-DD
  const isoToLocalDate = (iso) => {
    if (!iso) return new Date();
    const parts = iso.split('-').map(Number);
    const y = parts[0] || new Date().getFullYear();
    const m = (parts[1] || 1) - 1;
    const d = parts[2] || 1;
    return new Date(y, m, d);
  };

  // Garante que a data inicial seja sempre em horário local, sem shift de fuso
  let initialISO;
  if (initialDate instanceof Date) {
    const y = initialDate.getFullYear();
    const m = String(initialDate.getMonth() + 1).padStart(2, '0');
    const d = String(initialDate.getDate()).padStart(2, '0');
    initialISO = `${y}-${m}-${d}`;
  } else if (typeof initialDate === 'string') {
    initialISO = initialDate.slice(0, 10);
  } else {
    initialISO = todayLocalISO;
  }

  let selectedDate   = initialISO || todayLocalISO;
  const selectedLocal = isoToLocalDate(selectedDate);
  let currentMonth   = new Date(selectedLocal.getFullYear(), selectedLocal.getMonth(), 1); // usado para o header (mês/ano)
  let isExpanded     = false; // false => só faixa da semana, true => mês completo

  // Mapa de agendamentos por dia
  const agendamentosMap = (agendamentos || []).reduce((acc, item) => {
    if (!item || !item.data) return acc;
    const dia = item.data;
    if (!acc[dia]) acc[dia] = { has: true, status: item.status || 'agendado' };
    // Se já existir e algum está cancelado, mantemos cancelado como prioridade visual
    if (item.status === 'cancelado') acc[dia].status = 'cancelado';
    else if (item.status === 'concluido' && acc[dia].status !== 'cancelado') acc[dia].status = 'concluido';
    return acc;
  }, {});

  const weekDayLetters = ['D','S','T','Q','Q','S','S'];
  const weekDayNames   = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  const formatMonthYear = (date) => {
    const str = date.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    return str.charAt(0).toUpperCase() + str.slice(1);
  };

  function buildWeekStrip(parent) {
    const strip = document.createElement('div');
    strip.className = 'calendar-week-strip';

    const baseSelected = isoToLocalDate(selectedDate);
    // início da semana (domingo)
    const weekStart = new Date(baseSelected);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());

    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const isToday   = iso === todayLocalISO;
      const isSelected = iso === selectedDate;
      const dayInfo   = agendamentosMap[iso];

      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'calendar-week-strip-day';
      el.dataset.date = iso;
      el.innerHTML = `
        <div class="cwd-top">${weekDayLetters[d.getDay()]}</div>
        <div class="cwd-number">${d.getDate()}</div>
        <div class="cwd-indicator"></div>
      `;

      if (isToday) el.classList.add('today');
      if (isSelected) el.classList.add('selected');
      if (dayInfo && dayInfo.has) {
        el.classList.add('has-event');
        el.classList.add('status-' + (dayInfo.status || 'agendado'));
      }

      el.addEventListener('click', () => {
        selectedDate = iso;
        // Se o mês exibido for diferente do mês da data clicada, ajusta
        const monthChanged = d.getMonth() !== currentMonth.getMonth() || d.getFullYear() !== currentMonth.getFullYear();
        if (monthChanged) {
          currentMonth = new Date(d);
          currentMonth.setDate(1);
        }
        drawCalendar();
        safeOnDateSelect(selectedDate);

        // === INÍCIO DO CÓDIGO PARA RESETAR O SCROLL HORIZONTAL ===
        const resumoScroll = document.getElementById('agendaResumoScroll');
        if (resumoScroll) {
          // ESTA LINHA É ESSENCIAL: Garante que o scroll comece no primeiro agendamento do dia.
          setTimeout(() => {
            resumoScroll.scrollLeft = 0;
          }, 0);
        }
        // === FIM DO CÓDIGO PARA RESETAR O SCROLL HORIZONTAL ===
      });

      strip.appendChild(el);

      // Mantém o dia selecionado visível, mas sem forçar rolagem automática para evitar "pulos" indesejados
      // if (isSelected) {
      //   setTimeout(() => {
      //     try {
      //       el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      //     } catch(e) {}
      //   }, 0);
      // }
    }

    parent.appendChild(strip);
  }

  function buildMonthGrid(parent) {
    const firstDay     = getFirstDayOfMonth(currentMonth);
    const lastDay      = getLastDayOfMonth(currentMonth);
    const daysInMonth  = lastDay.getDate();
    const startWeekday = firstDay.getDay(); // 0 = domingo

    const weekDaysRow = document.createElement('div');
    weekDaysRow.className = 'calendar-weekdays';
    weekDaysRow.innerHTML = weekDayNames.map(d => `<span>${d}</span>`).join('');
    parent.appendChild(weekDaysRow);

    const grid = document.createElement('div');
    grid.className = 'calendar-grid';

    // Preenche dias do mês anterior (espaços à esquerda)
    for (let i = 0; i < startWeekday; i++) {
      const prev = new Date(firstDay);
      prev.setDate(firstDay.getDate() - (startWeekday - i));
      const prevEl = document.createElement('div');
      prevEl.className = 'calendar-day empty';
      prevEl.textContent = prev.getDate();
      grid.appendChild(prevEl);
    }

    // Dias do mês atual
    for (let dNum = 1; dNum <= daysInMonth; dNum++) {
      const d = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), dNum);
      const iso  = d.toISOString().slice(0, 10);
      const isToday   = iso === todayLocalISO;
      const isSelected = iso === selectedDate;
      const dayInfo   = agendamentosMap[iso];

      const el = document.createElement('div');
      el.className = 'calendar-day';
      el.dataset.date = iso;
      el.innerHTML = `
        <div class="day-number">${dNum}</div>
        <div class="day-indicator"></div>
      `;

      if (isToday) el.classList.add('today');
      if (isSelected) el.classList.add('selected');
      if (dayInfo && dayInfo.has) {
        el.classList.add('has-event');
        el.classList.add('status-' + (dayInfo.status || 'agendado'));
      }

      el.addEventListener('click', () => {
        selectedDate = iso;
        drawCalendar();
        safeOnDateSelect(selectedDate);
      });

      grid.appendChild(el);
    }

    parent.appendChild(grid);
  }

  function drawCalendar() {
    container.innerHTML = '';

    // Card wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'calendar-inner' + (isExpanded ? ' calendar-expanded' : ' calendar-collapsed');
    container.appendChild(wrapper);

    // Cabeçalho
    const header = document.createElement('div');
    header.className = 'calendar-header';

    const left = document.createElement('button');
    left.type = 'button';
    left.className = 'calendar-nav-btn';
    left.dataset.action = 'prev';
    left.textContent = '<';

    const title = document.createElement('h3');
    title.className = 'calendar-title';
    title.textContent = formatMonthYear(currentMonth);

    const right = document.createElement('button');
    right.type = 'button';
    right.className = 'calendar-nav-btn';
    right.dataset.action = 'next';
    right.textContent = '>';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'calendar-toggle';
    toggle.innerHTML = (isExpanded ? 'Recolher' : 'Ver mês') + ' <i class="fa fa-chevron-' + (isExpanded ? 'up' : 'down') + '"></i>';

    const leftGroup  = document.createElement('div');
    leftGroup.className = 'calendar-header-left';
    leftGroup.appendChild(left);
    leftGroup.appendChild(title);
    const rightGroup = document.createElement('div');
    rightGroup.className = 'calendar-header-right';
    rightGroup.appendChild(toggle);
    rightGroup.appendChild(right);

    header.appendChild(leftGroup);
    header.appendChild(rightGroup);
    wrapper.appendChild(header);

    // Faixa da semana SEMPRE aparece
    buildWeekStrip(wrapper);

    // Grid do mês só quando expandido
    if (isExpanded) {
      buildMonthGrid(wrapper);
    }

    // Eventos dos botões
    left.onclick = () => {
      currentMonth.setMonth(currentMonth.getMonth() - 1);
      // Ajusta selectedDate para ficar dentro do novo mês se estiver muito distante
      const tmp = new Date(currentMonth);
      tmp.setDate(1);
      selectedDate = tmp.toISOString().slice(0, 10);
      drawCalendar();
      safeOnDateSelect(selectedDate);
    };
    right.onclick = () => {
      currentMonth.setMonth(currentMonth.getMonth() + 1);
      const tmp = new Date(currentMonth);
      tmp.setDate(1);
      selectedDate = tmp.toISOString().slice(0, 10);
      drawCalendar();
      safeOnDateSelect(selectedDate);
    };
    toggle.onclick = () => {
      isExpanded = !isExpanded;
      drawCalendar();
    };
  }

  // Inicializa
  drawCalendar();
}

window.renderCalendar = renderCalendar;

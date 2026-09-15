const SNAPSHOT_URL = './public/portfolio.snapshot.json';

const positions = {
  projecttt: [50, 17],
  pablo: [34, 35],
  nadi: [50, 36],
  checkpoint: [67, 34],
  'goods-to-go': [51, 55],
  financekitstudio: [19, 57],
  deadline: [81, 55],
  upwork: [18, 77],
  fastwork: [82, 76],
  yia: [37, 74],
  ydm: [62, 73],
  career: [42, 91],
  learning: [62, 91],
};

const state = {
  snapshot: null,
  view: 'map',
  selectedProjectId: null,
  query: '',
  status: '',
  priority: '',
  ecosystemContext: false,
};

const els = {
  shell: document.querySelector('.app-shell'),
  loadingState: document.querySelector('#loadingState'),
  errorState: document.querySelector('#errorState'),
  verificationSummary: document.querySelector('#verificationSummary'),
  searchInput: document.querySelector('#searchInput'),
  statusFilter: document.querySelector('#statusFilter'),
  priorityFilter: document.querySelector('#priorityFilter'),
  ecosystemToggle: document.querySelector('#ecosystemToggle'),
  resetButton: document.querySelector('#resetButton'),
  mapStage: document.querySelector('#mapStage'),
  mapFrame: document.querySelector('#mapFrame'),
  mapEmpty: document.querySelector('#mapEmpty'),
  relationshipLayer: document.querySelector('#relationshipLayer'),
  portfolioList: document.querySelector('#portfolioList'),
  ecosystemGrid: document.querySelector('#ecosystemGrid'),
  ecosystemStatus: document.querySelector('#ecosystemStatus'),
  detailDrawer: document.querySelector('#detailDrawer'),
  drawerContent: document.querySelector('#drawerContent'),
  drawerClose: document.querySelector('#drawerClose'),
};

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeURL(value) {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch (_) {
    return null;
  }
  return null;
}

function titleFromSlug(value) {
  return String(value ?? '')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function setBrandFromSnapshot(snapshot) {
  const brand = snapshot.brand || {};
  const color = brand.color || {};
  const motion = brand.motion || {};
  const root = document.documentElement;
  if (color.paper) root.style.setProperty('--paper', color.paper);
  if (color.ink) root.style.setProperty('--ink', color.ink);
  if (color.muted) root.style.setProperty('--muted', color.muted);
  if (color.panel_muted) root.style.setProperty('--panel-muted', color.panel_muted);
  if (color.hairline?.hex) {
    const alpha = Number(color.hairline.alpha ?? 0.12);
    root.style.setProperty('--hairline', `color-mix(in srgb, ${color.hairline.hex} ${Math.round(alpha * 100)}%, transparent)`);
  }
  if (motion.fast_ms) root.style.setProperty('--motion-fast', `${motion.fast_ms}ms`);
  if (motion.standard_ms) root.style.setProperty('--motion-standard', `${motion.standard_ms}ms`);
  if (motion.slow_ms) root.style.setProperty('--motion-slow', `${motion.slow_ms}ms`);
  if (Array.isArray(motion.easing) && motion.easing.length === 4) {
    root.style.setProperty('--ease', `cubic-bezier(${motion.easing.join(', ')})`);
  }
}

function populateFilters(snapshot) {
  for (const value of snapshot.filters?.portfolio_status || []) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = titleFromSlug(value);
    els.statusFilter.append(option);
  }
  for (const value of snapshot.filters?.priority || []) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    els.priorityFilter.append(option);
  }
}

function ecosystemIndex() {
  return new Map((state.snapshot?.ecosystem || []).map((item) => [item.id, item]));
}

function workstreamIndex() {
  return new Map((state.snapshot?.workstreams || []).map((item) => [item.id, item]));
}

function projectMatches(project) {
  if (state.status && project.portfolio?.status !== state.status) return false;
  if (state.priority && project.portfolio?.priority !== state.priority) return false;
  if (!state.query) return true;

  const q = state.query.toLowerCase();
  const ecosystems = ecosystemIndex();
  const workstreams = workstreamIndex();
  const searchable = [
    project.name,
    ...(project.aliases || []),
    project.entity_type,
    project.category,
    project.portfolio?.status,
    project.portfolio?.priority,
    project.state?.current,
    project.state?.current_milestone,
    project.state?.next_milestone,
    ...(project.repository_refs || []),
    ...(project.workstreams || []).map((id) => workstreams.get(id)?.name),
    ...(project.ecosystem_refs || []).flatMap((id) => {
      const entity = ecosystems.get(id);
      return entity ? [entity.name, ...(entity.types || [])] : [];
    }),
  ].filter(Boolean).join(' ').toLowerCase();

  return searchable.includes(q);
}

function relatedProjectIds(projectId) {
  if (!projectId) return new Set();
  const projects = new Set((state.snapshot?.projects || []).map((item) => item.id));
  const related = new Set([projectId]);
  for (const edge of state.snapshot?.relationships || []) {
    if (edge.from === projectId && projects.has(edge.to)) related.add(edge.to);
    if (edge.to === projectId && projects.has(edge.from)) related.add(edge.from);
  }
  return related;
}

function healthNeedsAttention(project) {
  const value = project.technical?.health;
  return value && !['healthy', 'not-applicable', 'pre-build'].includes(value);
}

function projectNodeMarkup(project) {
  const health = healthNeedsAttention(project)
    ? `<span class="health-marker">${escapeHTML(titleFromSlug(project.technical?.health))}</span>`
    : '';
  const next = project.state?.next_milestone || project.state?.current_milestone || project.state?.current || '';
  return `
    <span class="project-name">${escapeHTML(project.name)}</span>
    <span class="project-meta">
      <span>${escapeHTML(titleFromSlug(project.portfolio?.status || 'Unknown'))}</span>
      <span>${escapeHTML(project.portfolio?.priority || '')}</span>
      ${health}
    </span>
    <span class="project-context">${escapeHTML(next)}</span>
  `;
}

function renderMap() {
  const projects = state.snapshot?.projects || [];
  const related = relatedProjectIds(state.selectedProjectId);
  els.mapStage.innerHTML = '';

  let visibleCount = 0;
  for (const project of projects) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'project-node';
    node.dataset.projectId = project.id;
    node.setAttribute('role', 'listitem');
    node.setAttribute('aria-label', `${project.name}, ${titleFromSlug(project.portfolio?.status || 'status unknown')}, ${project.portfolio?.priority || 'priority unknown'}`);
    node.innerHTML = projectNodeMarkup(project);

    const [x, y] = positions[project.id] || [50, 50];
    node.style.left = `${x}%`;
    node.style.top = `${y}%`;

    const matches = projectMatches(project);
    if (!matches) node.classList.add('is-filtered');
    if (matches) visibleCount += 1;
    if (state.selectedProjectId === project.id) node.classList.add('is-selected');
    if (state.selectedProjectId && !related.has(project.id)) node.classList.add('is-muted');

    node.addEventListener('click', () => selectProject(project.id));
    els.mapStage.append(node);
  }

  els.mapEmpty.hidden = visibleCount > 0;
  renderEcosystemContext();
  requestAnimationFrame(renderRelationships);
}

function relationshipKind(edge) {
  if (edge.state === 'planned') return 'planned';
  if (String(edge.type || '').includes('evidence')) return 'evidence';
  return 'structural';
}

function projectNodeCenter(projectId) {
  const node = els.mapStage.querySelector(`[data-project-id="${CSS.escape(projectId)}"]`);
  if (!node || node.classList.contains('is-filtered')) return null;
  const frameRect = els.mapFrame.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  return {
    x: rect.left - frameRect.left + rect.width / 2,
    y: rect.top - frameRect.top + rect.height / 2,
  };
}

function renderRelationships() {
  const projects = new Set((state.snapshot?.projects || []).map((item) => item.id));
  const related = relatedProjectIds(state.selectedProjectId);
  const width = els.mapFrame.clientWidth;
  const height = els.mapFrame.clientHeight;
  els.relationshipLayer.setAttribute('viewBox', `0 0 ${width} ${height}`);
  els.relationshipLayer.innerHTML = '';

  for (const edge of state.snapshot?.relationships || []) {
    if (!projects.has(edge.from) || !projects.has(edge.to)) continue;
    const start = projectNodeCenter(edge.from);
    const end = projectNodeCenter(edge.to);
    if (!start || !end) continue;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', start.x);
    line.setAttribute('y1', start.y);
    line.setAttribute('x2', end.x);
    line.setAttribute('y2', end.y);
    line.classList.add('relationship-line');
    line.dataset.kind = relationshipKind(edge);

    const connectsSelected = state.selectedProjectId && (edge.from === state.selectedProjectId || edge.to === state.selectedProjectId);
    if (connectsSelected) line.classList.add('is-related');
    if (state.selectedProjectId && !(related.has(edge.from) && related.has(edge.to))) line.classList.add('is-muted');
    els.relationshipLayer.append(line);
  }
}

function ecosystemPlacement(index, total, baseX, baseY) {
  const angle = (Math.PI * 2 * index) / Math.max(total, 1) - Math.PI / 2;
  const radiusX = 10;
  const radiusY = 13;
  return [
    Math.max(5, Math.min(95, baseX + Math.cos(angle) * radiusX)),
    Math.max(8, Math.min(94, baseY + Math.sin(angle) * radiusY)),
  ];
}

function renderEcosystemContext() {
  els.mapStage.querySelectorAll('.ecosystem-object').forEach((node) => node.remove());
  if (!state.ecosystemContext || !state.selectedProjectId) return;

  const project = state.snapshot.projects.find((item) => item.id === state.selectedProjectId);
  if (!project) return;
  const entities = ecosystemIndex();
  const refs = (project.default_ecosystem_refs || project.visual?.default_ecosystem_refs || project.ecosystem_refs || []).slice(0, 5);
  const [baseX, baseY] = positions[project.id] || [50, 50];

  refs.forEach((id, index) => {
    const entity = entities.get(id);
    if (!entity) return;
    const [x, y] = ecosystemPlacement(index, refs.length, baseX, baseY);
    const object = document.createElement('div');
    object.className = 'ecosystem-object';
    object.style.left = `${x}%`;
    object.style.top = `${y}%`;
    object.innerHTML = `<span class="ecosystem-mark" aria-hidden="true"></span><span>${escapeHTML(entity.name)}</span>`;
    els.mapStage.append(object);
  });
}

function renderPortfolio() {
  const projects = (state.snapshot?.projects || []).filter(projectMatches);
  els.portfolioList.innerHTML = projects.map((project) => `
    <article class="portfolio-row" data-project-row="${escapeHTML(project.id)}">
      <button type="button" data-open-project="${escapeHTML(project.id)}" class="row-name">${escapeHTML(project.name)}</button>
      <div class="row-meta">${escapeHTML(titleFromSlug(project.portfolio?.status || 'Unknown'))} · ${escapeHTML(project.portfolio?.priority || '')}</div>
      <div class="row-meta">${escapeHTML(titleFromSlug(project.technical?.health || 'unknown'))}</div>
      <div class="row-next">${escapeHTML(project.state?.next_milestone || project.state?.current_milestone || '')}</div>
    </article>
  `).join('');

  els.portfolioList.querySelectorAll('[data-open-project]').forEach((button) => {
    button.addEventListener('click', () => selectProject(button.dataset.openProject));
  });
}

function renderEcosystem() {
  const q = state.query.toLowerCase();
  const entities = (state.snapshot?.ecosystem || []).filter((entity) => {
    if (!q) return true;
    return [entity.name, ...(entity.types || []), entity.usage_state].filter(Boolean).join(' ').toLowerCase().includes(q);
  });

  const mcp = state.snapshot?.verification?.mcp || {};
  els.ecosystemStatus.textContent = mcp.verified_count > 0
    ? `${mcp.verified_count} verified MCP configuration${mcp.verified_count === 1 ? '' : 's'}.`
    : 'No verified MCP. Registry inventory remains incomplete.';

  els.ecosystemGrid.innerHTML = entities.map((entity) => `
    <article class="ecosystem-card">
      <h2>${escapeHTML(entity.name)}</h2>
      <p>${escapeHTML((entity.types || []).join(' · '))}</p>
      <p>${escapeHTML(titleFromSlug(entity.usage_state || 'unknown'))}</p>
    </article>
  `).join('');
}

function sourceListMarkup(project) {
  const items = (project.source_indicators || []).map((source) => {
    if (source.source === 'github' && source.repo) {
      const href = safeURL(`https://github.com/${source.repo}`);
      return href ? `<li>GitHub: <a href="${escapeHTML(href)}" target="_blank" rel="noreferrer">${escapeHTML(source.repo)}</a></li>` : '';
    }
    if (source.source === 'trello' && source.url) {
      const href = safeURL(source.url);
      return href ? `<li>Trello: <a href="${escapeHTML(href)}" target="_blank" rel="noreferrer">operational source</a></li>` : '';
    }
    if (source.source === 'progress-snapshot' && source.last_activity_at) {
      return `<li>Progress snapshot activity: ${escapeHTML(source.last_activity_at)}</li>`;
    }
    return '';
  }).filter(Boolean);
  return items.length ? `<ul class="drawer-list">${items.join('')}</ul>` : '<p>No linked source is exposed in the runtime snapshot.</p>';
}

function renderDrawer(project) {
  const workstreams = workstreamIndex();
  const ecosystems = ecosystemIndex();
  const childWorkstreams = (project.workstreams || []).map((id) => workstreams.get(id)).filter(Boolean);
  const entities = (project.ecosystem_refs || []).map((id) => ecosystems.get(id)).filter(Boolean);
  const verification = project.verification || {};

  els.drawerContent.innerHTML = `
    <p class="drawer-kicker">${escapeHTML(titleFromSlug(project.entity_type || 'Project'))}</p>
    <h1 class="drawer-title">${escapeHTML(project.name)}</h1>
    <div class="drawer-meta">
      <span>${escapeHTML(titleFromSlug(project.portfolio?.status || 'Unknown'))}</span>
      <span>${escapeHTML(project.portfolio?.priority || '')}</span>
      <span>${escapeHTML(titleFromSlug(project.technical?.health || 'unknown'))}</span>
    </div>

    <section class="drawer-section">
      <h2>Now</h2>
      <p>${escapeHTML(project.state?.current || 'Unknown')}</p>
      ${childWorkstreams.length ? `<div class="workstream-list">${childWorkstreams.map((item) => `<div class="workstream-item">${escapeHTML(item.name)} · ${escapeHTML(titleFromSlug(item.status || 'unknown'))}</div>`).join('')}</div>` : ''}
    </section>

    <section class="drawer-section">
      <h2>Next</h2>
      <p>${escapeHTML(project.state?.next_milestone || project.state?.current_milestone || 'Unknown')}</p>
    </section>

    <section class="drawer-section">
      <h2>Ecosystem</h2>
      ${entities.length ? `<ul class="drawer-list">${entities.map((item) => `<li>${escapeHTML(item.name)} · ${escapeHTML(titleFromSlug(item.usage_state || 'unknown'))}</li>`).join('')}</ul>` : '<p>No ecosystem relationship is exposed for this project.</p>'}
    </section>

    <section class="drawer-section">
      <h2>Sources</h2>
      ${sourceListMarkup(project)}
    </section>

    <section class="drawer-section">
      <h2>Verification</h2>
      <p>${escapeHTML(titleFromSlug(verification.status || 'unknown'))}</p>
      ${(verification.unknown_fields || []).length ? `<ul class="drawer-list">${verification.unknown_fields.map((item) => `<li>Unknown: ${escapeHTML(titleFromSlug(item))}</li>`).join('')}</ul>` : ''}
    </section>
  `;
}

function selectProject(projectId) {
  const project = state.snapshot?.projects.find((item) => item.id === projectId);
  if (!project) return;
  state.selectedProjectId = projectId;
  renderDrawer(project);
  els.detailDrawer.classList.add('is-open');
  els.detailDrawer.setAttribute('aria-hidden', 'false');
  renderMap();
}

function closeDrawer() {
  state.selectedProjectId = null;
  els.detailDrawer.classList.remove('is-open');
  els.detailDrawer.setAttribute('aria-hidden', 'true');
  renderMap();
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('[data-view-target]').forEach((button) => {
    const active = button.dataset.viewTarget === view;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-view]').forEach((panel) => {
    const active = panel.dataset.view === view;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  });
  if (view === 'map') requestAnimationFrame(renderRelationships);
}

function applyFilters() {
  state.query = els.searchInput.value.trim();
  state.status = els.statusFilter.value;
  state.priority = els.priorityFilter.value;
  renderMap();
  renderPortfolio();
  renderEcosystem();
}

function resetControls() {
  els.searchInput.value = '';
  els.statusFilter.value = '';
  els.priorityFilter.value = '';
  els.ecosystemToggle.checked = false;
  state.query = '';
  state.status = '';
  state.priority = '';
  state.ecosystemContext = false;
  closeDrawer();
  renderPortfolio();
  renderEcosystem();
}

function bindEvents() {
  document.querySelectorAll('[data-view-target]').forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.viewTarget));
  });
  els.searchInput.addEventListener('input', applyFilters);
  els.statusFilter.addEventListener('change', applyFilters);
  els.priorityFilter.addEventListener('change', applyFilters);
  els.ecosystemToggle.addEventListener('change', () => {
    state.ecosystemContext = els.ecosystemToggle.checked;
    renderMap();
  });
  els.resetButton.addEventListener('click', resetControls);
  els.drawerClose.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.selectedProjectId) closeDrawer();
  });
  window.addEventListener('resize', () => requestAnimationFrame(renderRelationships));
}

async function boot() {
  bindEvents();
  try {
    const response = await fetch(SNAPSHOT_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Snapshot request failed with ${response.status}`);
    const snapshot = await response.json();
    if (!Array.isArray(snapshot.projects) || snapshot.projects.length !== 13) {
      throw new Error('Snapshot does not contain the canonical 13 projects');
    }
    state.snapshot = snapshot;
    setBrandFromSnapshot(snapshot);
    populateFilters(snapshot);

    const unknownCount = Number(snapshot.verification?.unknown_count || 0);
    els.verificationSummary.textContent = unknownCount > 0
      ? `Partial verification · ${unknownCount} open`
      : 'Verification complete';

    renderMap();
    renderPortfolio();
    renderEcosystem();
    els.shell.dataset.appState = 'ready';
    els.loadingState.hidden = true;
  } catch (error) {
    console.error(error);
    els.shell.dataset.appState = 'error';
    els.loadingState.hidden = true;
    els.errorState.hidden = false;
  }
}

boot();

const SNAPSHOT_URL = './public/portfolio.snapshot.json';
const LOGO_SPRITE = './public/logos/brand-symbols.svg';

const logoSymbols = {
  github: 'github',
  trello: 'trello',
  discord: 'discord',
  obsidian: 'obsidian',
  n8n: 'n8n',
  shopee: 'shopee',
  etsy: 'etsy',
  'google-sheets': 'googlesheets',
  vercel: 'vercel',
  supabase: 'supabase',
};

const viewport = {
  x: 0,
  y: 0,
  scale: 1,
  maxScale: 2.4,
  pointers: new Map(),
  panStart: null,
  pinchStart: null,
};

let snapshot = null;
let expandedProjectId = null;
let lastSelectedProjectId = null;
let syncQueued = false;

const els = {
  frame: document.querySelector('#mapFrame'),
  stage: document.querySelector('#mapStage'),
  relationships: document.querySelector('#relationshipLayer'),
  drawerContent: document.querySelector('#drawerContent'),
  ecosystemGrid: document.querySelector('#ecosystemGrid'),
};

const mobileQuery = window.matchMedia('(max-width: 760px)');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function minimumScale() {
  return mobileQuery.matches ? 0.22 : 0.65;
}

function selectedProjectId() {
  return els.stage?.querySelector('.project-node.is-selected')?.dataset.projectId || null;
}

function selectedProject() {
  const id = selectedProjectId();
  return snapshot?.projects?.find((project) => project.id === id) || null;
}

function workstreamById(id) {
  return snapshot?.workstreams?.find((item) => item.id === id) || null;
}

function ecosystemById(id) {
  return snapshot?.ecosystem?.find((item) => item.id === id) || null;
}

function applyViewportTransform() {
  if (!els.stage) return;
  els.stage.style.transformOrigin = '0 0';
  els.stage.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`;
  queueRelationshipSync();
}

function resetViewport() {
  viewport.x = 0;
  viewport.y = 0;
  viewport.scale = 1;
  applyViewportTransform();
  updateViewportReadout();
}

function fitAll() {
  if (!els.frame || !els.stage) return;
  const frameRect = els.frame.getBoundingClientRect();
  const stageWidth = els.stage.offsetWidth || frameRect.width;
  const stageHeight = els.stage.offsetHeight || frameRect.height;
  const padding = mobileQuery.matches ? 14 : 26;
  const usableWidth = Math.max(1, frameRect.width - padding * 2);
  const usableHeight = Math.max(1, frameRect.height - padding * 2);
  const scale = clamp(Math.min(usableWidth / stageWidth, usableHeight / stageHeight), minimumScale(), 1);
  viewport.scale = scale;
  viewport.x = (frameRect.width - stageWidth * scale) / 2;
  viewport.y = (frameRect.height - stageHeight * scale) / 2;
  applyViewportTransform();
  updateViewportReadout();
}

function zoomAround(clientX, clientY, nextScale) {
  if (!els.frame) return;
  const rect = els.frame.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const worldX = (px - viewport.x) / viewport.scale;
  const worldY = (py - viewport.y) / viewport.scale;
  const scale = clamp(nextScale, minimumScale(), viewport.maxScale);
  viewport.x = px - worldX * scale;
  viewport.y = py - worldY * scale;
  viewport.scale = scale;
  applyViewportTransform();
  updateViewportReadout();
}

function setScaleFromControl(nextScale) {
  if (!els.frame) return;
  const rect = els.frame.getBoundingClientRect();
  zoomAround(rect.left + rect.width / 2, rect.top + rect.height / 2, nextScale);
}

function buildViewportControls() {
  if (!els.frame || els.frame.querySelector('.map-viewport-controls')) return;
  const controls = document.createElement('div');
  controls.className = 'map-viewport-controls';
  controls.setAttribute('aria-label', 'Map viewport controls');
  controls.innerHTML = `
    <button type="button" data-map-action="zoom-out" aria-label="Zoom out">−</button>
    <button type="button" data-map-action="fit" aria-label="Fit full map">Fit</button>
    <button type="button" data-map-action="reset" class="map-zoom-readout" aria-label="Reset map to 100 percent">100%</button>
    <button type="button" data-map-action="zoom-in" aria-label="Zoom in">+</button>
    <button type="button" data-map-action="download" class="map-download-action" aria-label="Download full map as PNG">Download</button>
  `;
  controls.addEventListener('click', (event) => {
    const button = event.target.closest('[data-map-action]');
    if (!button) return;
    const action = button.dataset.mapAction;
    if (action === 'zoom-in') setScaleFromControl(viewport.scale * 1.15);
    if (action === 'zoom-out') setScaleFromControl(viewport.scale / 1.15);
    if (action === 'fit') fitAll();
    if (action === 'reset') resetViewport();
    if (action === 'download') void downloadMapPNG(button);
  });
  els.frame.append(controls);
}

function updateViewportReadout() {
  const readout = els.frame?.querySelector('.map-zoom-readout');
  if (readout) readout.textContent = `${Math.round(viewport.scale * 100)}%`;
}

function pointerPair() {
  return [...viewport.pointers.values()].slice(0, 2);
}

function distanceBetween(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function capturePointer(pointerId) {
  try { els.frame.setPointerCapture(pointerId); } catch (_) { }
}

function beginPinch() {
  const pair = pointerPair();
  if (pair.length < 2 || !els.frame) return;
  const rect = els.frame.getBoundingClientRect();
  const center = midpoint(pair[0], pair[1]);
  const localX = center.x - rect.left;
  const localY = center.y - rect.top;
  viewport.pinchStart = {
    distance: Math.max(1, distanceBetween(pair[0], pair[1])),
    scale: viewport.scale,
    worldX: (localX - viewport.x) / viewport.scale,
    worldY: (localY - viewport.y) / viewport.scale,
  };
  viewport.panStart = null;
}

function bindViewportGestures() {
  if (!els.frame) return;
  els.frame.classList.add('is-interactive-map');

  els.frame.addEventListener('wheel', (event) => {
    event.preventDefault();
    const multiplier = Math.exp(-event.deltaY * 0.0014);
    zoomAround(event.clientX, event.clientY, viewport.scale * multiplier);
  }, { passive: false });

  els.frame.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const interactive = Boolean(event.target.closest('button, a, input, select, .project-node, .ecosystem-object, .workstream-object, .map-viewport-controls'));
    if (interactive && event.pointerType !== 'touch') return;

    viewport.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, interactive });

    if (viewport.pointers.size >= 2) {
      for (const pointerId of viewport.pointers.keys()) capturePointer(pointerId);
      beginPinch();
      return;
    }

    if (!interactive) capturePointer(event.pointerId);
    viewport.panStart = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
      allowed: !interactive,
    };
    if (!interactive) els.frame.classList.add('is-panning');
  });

  els.frame.addEventListener('pointermove', (event) => {
    if (!viewport.pointers.has(event.pointerId)) return;
    viewport.pointers.set(event.pointerId, {
      ...viewport.pointers.get(event.pointerId),
      x: event.clientX,
      y: event.clientY,
    });

    if (viewport.pointers.size >= 2) {
      event.preventDefault();
      if (!viewport.pinchStart) beginPinch();
      const pair = pointerPair();
      const center = midpoint(pair[0], pair[1]);
      const rect = els.frame.getBoundingClientRect();
      const scale = clamp(
        viewport.pinchStart.scale * (distanceBetween(pair[0], pair[1]) / viewport.pinchStart.distance),
        minimumScale(),
        viewport.maxScale,
      );
      viewport.scale = scale;
      viewport.x = center.x - rect.left - viewport.pinchStart.worldX * scale;
      viewport.y = center.y - rect.top - viewport.pinchStart.worldY * scale;
      applyViewportTransform();
      updateViewportReadout();
      return;
    }

    if (viewport.panStart?.pointerId !== event.pointerId || !viewport.panStart.allowed) return;
    viewport.x = viewport.panStart.originX + (event.clientX - viewport.panStart.startX);
    viewport.y = viewport.panStart.originY + (event.clientY - viewport.panStart.startY);
    applyViewportTransform();
  }, { passive: false });

  const endPointer = (event) => {
    if (!viewport.pointers.has(event.pointerId)) return;
    viewport.pointers.delete(event.pointerId);
    try {
      if (els.frame.hasPointerCapture(event.pointerId)) els.frame.releasePointerCapture(event.pointerId);
    } catch (_) { }

    viewport.pinchStart = null;
    els.frame.classList.remove('is-panning');
    const remaining = pointerPair();
    if (remaining.length === 1) {
      viewport.panStart = {
        pointerId: [...viewport.pointers.keys()][0],
        startX: remaining[0].x,
        startY: remaining[0].y,
        originX: viewport.x,
        originY: viewport.y,
        allowed: !remaining[0].interactive,
      };
    } else {
      viewport.panStart = null;
    }
  };

  els.frame.addEventListener('pointerup', endPointer);
  els.frame.addEventListener('pointercancel', endPointer);
}

function nodeCenter(node) {
  if (!node || node.classList.contains('is-filtered')) return null;
  const frameRect = els.frame.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  return {
    x: rect.left - frameRect.left + rect.width / 2,
    y: rect.top - frameRect.top + rect.height / 2,
  };
}

function relationshipKind(edge) {
  if (edge.state === 'planned') return 'planned';
  if (String(edge.type || '').includes('evidence')) return 'evidence';
  return 'structural';
}

function relatedPrimaryProjects(projectId) {
  const projects = new Set((snapshot?.projects || []).map((item) => item.id));
  const related = new Set(projectId ? [projectId] : []);
  for (const edge of snapshot?.relationships || []) {
    if (edge.from === projectId && projects.has(edge.to)) related.add(edge.to);
    if (edge.to === projectId && projects.has(edge.from)) related.add(edge.from);
  }
  return related;
}

function relationshipCurve(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const bend = 0.36;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return {
      c1: { x: start.x + dx * bend, y: start.y },
      c2: { x: end.x - dx * bend, y: end.y },
    };
  }
  return {
    c1: { x: start.x, y: start.y + dy * bend },
    c2: { x: end.x, y: end.y - dy * bend },
  };
}

function lineElement(start, end, classes, kind = 'structural') {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const { c1, c2 } = relationshipCurve(start, end);
  path.setAttribute('d', `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`);
  path.classList.add('relationship-line', ...classes);
  path.dataset.kind = kind;
  return path;
}

function syncRelationships() {
  syncQueued = false;
  if (!snapshot || !els.relationships || !els.frame) return;
  const width = els.frame.clientWidth;
  const height = els.frame.clientHeight;
  els.relationships.setAttribute('viewBox', `0 0 ${width} ${height}`);
  els.relationships.innerHTML = '';

  const primaryIds = new Set(snapshot.projects.map((item) => item.id));
  const selectedId = selectedProjectId();
  const related = relatedPrimaryProjects(selectedId);

  for (const edge of snapshot.relationships || []) {
    if (!primaryIds.has(edge.from) || !primaryIds.has(edge.to)) continue;
    const fromNode = els.stage.querySelector(`[data-project-id="${CSS.escape(edge.from)}"]`);
    const toNode = els.stage.querySelector(`[data-project-id="${CSS.escape(edge.to)}"]`);
    const start = nodeCenter(fromNode);
    const end = nodeCenter(toNode);
    if (!start || !end) continue;
    const classes = [];
    if (selectedId && (edge.from === selectedId || edge.to === selectedId)) classes.push('is-related');
    if (selectedId && !(related.has(edge.from) && related.has(edge.to))) classes.push('is-muted');
    els.relationships.append(lineElement(start, end, classes, relationshipKind(edge)));
  }

  if (expandedProjectId && expandedProjectId === selectedId) {
    const parent = els.stage.querySelector(`[data-project-id="${CSS.escape(expandedProjectId)}"]`);
    const parentCenter = nodeCenter(parent);
    if (parentCenter) {
      els.stage.querySelectorAll('.workstream-object').forEach((workstreamNode) => {
        const childCenter = nodeCenter(workstreamNode);
        if (!childCenter) return;
        els.relationships.append(lineElement(parentCenter, childCenter, ['workstream-relationship', 'is-related']));
      });
    }
  }
}

function queueRelationshipSync() {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(syncRelationships);
}

function workstreamOffsets(total, baseY) {
  const upward = baseY > 72;
  const direction = upward ? -1 : 1;
  const patterns = {
    1: [[0, 12]],
    2: [[-7, 11], [7, 11]],
    3: [[-9, 10], [0, 14], [9, 10]],
    4: [[-12, 9], [-4, 14], [4, 14], [12, 9]],
  };
  return (patterns[Math.min(total, 4)] || []).map(([x, y]) => [x, y * direction]);
}

function clearExpandedWorkstreams() {
  const nodes = els.stage?.querySelectorAll('.workstream-object') || [];
  nodes.forEach((node) => node.remove());
  if (els.stage) delete els.stage.dataset.workstreamsFor;
}

function renderExpandedWorkstreams() {
  if (!snapshot || !els.stage) return;
  const selectedId = selectedProjectId();
  const validExpansion = expandedProjectId && expandedProjectId === selectedId;
  if (!validExpansion) {
    if (els.stage.querySelector('.workstream-object')) clearExpandedWorkstreams();
    queueRelationshipSync();
    return;
  }

  const project = snapshot.projects.find((item) => item.id === expandedProjectId);
  const parentNode = els.stage.querySelector(`[data-project-id="${CSS.escape(expandedProjectId)}"]`);
  if (!project || !parentNode || parentNode.classList.contains('is-filtered')) {
    if (els.stage.querySelector('.workstream-object')) clearExpandedWorkstreams();
    queueRelationshipSync();
    return;
  }

  const childIds = (project.workstreams || []).slice(0, 4);
  if (!childIds.length) return;
  const existing = [...els.stage.querySelectorAll('.workstream-object')];
  const existingIds = existing.map((node) => node.dataset.workstreamId);
  const alreadyRendered = els.stage.dataset.workstreamsFor === expandedProjectId
    && existingIds.length === childIds.length
    && childIds.every((id, index) => existingIds[index] === id);
  if (alreadyRendered) {
    queueRelationshipSync();
    return;
  }

  clearExpandedWorkstreams();
  const baseX = Number.parseFloat(parentNode.style.left) || 50;
  const baseY = Number.parseFloat(parentNode.style.top) || 50;
  const offsets = workstreamOffsets(childIds.length, baseY);

  childIds.forEach((id, index) => {
    const item = workstreamById(id);
    if (!item) return;
    const [offsetX, offsetY] = offsets[index] || [0, 12];
    const node = document.createElement('div');
    node.className = 'workstream-object';
    node.dataset.workstreamId = item.id;
    node.setAttribute('role', 'listitem');
    node.tabIndex = 0;
    node.style.left = `${clamp(baseX + offsetX, 6, 94)}%`;
    node.style.top = `${clamp(baseY + offsetY, 7, 94)}%`;
    node.innerHTML = `
      <span class="workstream-name">${escapeHTML(item.name)}</span>
      <span class="workstream-status">${escapeHTML(titleFromSlug(item.status || 'unknown'))}</span>
    `;
    els.stage.append(node);
  });
  els.stage.dataset.workstreamsFor = expandedProjectId;
  queueRelationshipSync();
}

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function titleFromSlug(value) {
  return String(value ?? '')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function decorateDrawer() {
  if (!snapshot || !els.drawerContent) return;
  const project = selectedProject();
  if (!project) return;
  const firstSection = els.drawerContent.querySelector('.drawer-section');
  if (!firstSection) return;

  if (!firstSection.querySelector('.workstream-map-toggle')) {
    const children = (project.workstreams || []).map(workstreamById).filter(Boolean);
    if (children.length) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'workstream-map-toggle';
      button.textContent = expandedProjectId === project.id ? 'Hide workstreams on map' : 'Show workstreams on map';
      button.setAttribute('aria-pressed', expandedProjectId === project.id ? 'true' : 'false');
      button.addEventListener('click', () => {
        expandedProjectId = expandedProjectId === project.id ? null : project.id;
        button.textContent = expandedProjectId === project.id ? 'Hide workstreams on map' : 'Show workstreams on map';
        button.setAttribute('aria-pressed', expandedProjectId === project.id ? 'true' : 'false');
        renderExpandedWorkstreams();
      });
      firstSection.append(button);
    }
  }

  if (!firstSection.querySelector('.drawer-map-download')) {
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'drawer-map-download';
    download.textContent = 'Download map';
    download.addEventListener('click', () => void downloadMapPNG(download));
    firstSection.append(download);
  }
}

function logoUse(entity) {
  const symbol = entity?.logo_key ? logoSymbols[entity.logo_key] : null;
  if (!symbol) return null;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('ecosystem-logo');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${LOGO_SPRITE}#${symbol}`);
  svg.append(use);
  return svg;
}

function decorateContextLogos() {
  const project = selectedProject();
  if (!project) return;
  const refs = (project.visual?.default_ecosystem_refs || project.ecosystem_refs || []).slice(0, 5);
  const objects = [...els.stage.querySelectorAll('.ecosystem-object')];
  objects.forEach((object, index) => {
    if (object.dataset.logoDecorated === 'true') return;
    const entity = ecosystemById(refs[index]);
    const svg = logoUse(entity);
    if (svg) {
      object.querySelector('.ecosystem-mark')?.remove();
      object.prepend(svg);
    }
    object.dataset.logoDecorated = 'true';
  });
}

function decorateGridLogos() {
  if (!snapshot || !els.ecosystemGrid) return;
  const byName = new Map(snapshot.ecosystem.map((item) => [item.name, item]));
  els.ecosystemGrid.querySelectorAll('.ecosystem-card').forEach((card) => {
    if (card.dataset.logoDecorated === 'true') return;
    const heading = card.querySelector('h2');
    const entity = byName.get(heading?.textContent?.trim());
    const svg = logoUse(entity);
    if (svg && heading) {
      const wrap = document.createElement('div');
      wrap.className = 'ecosystem-card-heading';
      heading.before(wrap);
      wrap.append(svg, heading);
    }
    card.dataset.logoDecorated = 'true';
  });
}

function percentPosition(node) {
  return {
    x: Number.parseFloat(node?.style.left) || 50,
    y: Number.parseFloat(node?.style.top) || 50,
  };
}

function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 2) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return;
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  lines.forEach((value, index) => ctx.fillText(value, x, y + index * lineHeight));
}

function exportCoordinates(node, width, height, margin) {
  const position = percentPosition(node);
  return {
    x: margin + (position.x / 100) * (width - margin * 2),
    y: margin + (position.y / 100) * (height - margin * 2),
  };
}

async function downloadMapPNG(trigger) {
  if (!snapshot || !els.stage) return;
  const originalText = trigger?.textContent;
  if (trigger) {
    trigger.disabled = true;
    trigger.textContent = 'Preparing…';
  }

  try {
    const width = 1800;
    const height = 1200;
    const margin = 84;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas export is unavailable');

    ctx.fillStyle = '#f7f7f2';
    ctx.fillRect(0, 0, width, height);
    ctx.textBaseline = 'top';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.fillStyle = '#111111';
    ctx.font = '600 25px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('projecttt', 54, 42);
    ctx.fillStyle = '#686864';
    ctx.font = '500 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('Portfolio map', 54, 77);

    const nodes = [...els.stage.querySelectorAll('.project-node:not(.is-filtered)')];
    const nodeById = new Map(nodes.map((node) => [node.dataset.projectId, node]));
    const selectedId = selectedProjectId();
    const related = relatedPrimaryProjects(selectedId);

    ctx.lineWidth = 1.5;
    for (const edge of snapshot.relationships || []) {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) continue;
      const start = exportCoordinates(from, width, height, margin);
      const end = exportCoordinates(to, width, height, margin);
      const { c1, c2 } = relationshipCurve(start, end);
      const relevant = selectedId && (edge.from === selectedId || edge.to === selectedId);
      const unrelated = selectedId && !(related.has(edge.from) && related.has(edge.to));
      ctx.strokeStyle = relevant ? 'rgba(17,17,17,.62)' : unrelated ? 'rgba(17,17,17,.10)' : 'rgba(17,17,17,.24)';
      ctx.lineWidth = relevant ? 2.2 : 1.4;
      if (relationshipKind(edge) === 'planned') ctx.setLineDash([10, 10]);
      else if (relationshipKind(edge) === 'evidence') ctx.setLineDash([3, 8]);
      else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const workstreamNodes = [...els.stage.querySelectorAll('.workstream-object')];
    const selectedNode = selectedId ? nodeById.get(selectedId) : null;
    if (selectedNode && workstreamNodes.length) {
      const parent = exportCoordinates(selectedNode, width, height, margin);
      ctx.strokeStyle = 'rgba(17,17,17,.34)';
      ctx.lineWidth = 1.4;
      workstreamNodes.forEach((node) => {
        const child = exportCoordinates(node, width, height, margin);
        const { c1, c2 } = relationshipCurve(parent, child);
        ctx.beginPath();
        ctx.moveTo(parent.x, parent.y);
        ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, child.x, child.y);
        ctx.stroke();
      });
    }

    nodes.forEach((node) => {
      const point = exportCoordinates(node, width, height, margin);
      const selected = node.classList.contains('is-selected');
      const muted = selectedId && !related.has(node.dataset.projectId);
      const name = node.querySelector('.project-name')?.textContent?.trim() || '';
      const meta = node.querySelector('.project-meta')?.textContent?.replace(/\s+/g, ' ')?.trim() || '';
      const context = node.querySelector('.project-context')?.textContent?.replace(/\s+/g, ' ')?.trim() || '';
      const boxWidth = 255;
      ctx.strokeStyle = selected ? '#111111' : muted ? 'rgba(17,17,17,.22)' : 'rgba(17,17,17,.34)';
      ctx.lineWidth = selected ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(point.x - boxWidth / 2, point.y - 42);
      ctx.lineTo(point.x + boxWidth / 2, point.y - 42);
      ctx.stroke();
      ctx.fillStyle = muted ? '#686864' : '#111111';
      ctx.font = '600 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText(name, point.x - boxWidth / 2, point.y - 30);
      ctx.fillStyle = '#686864';
      ctx.font = '500 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText(meta, point.x - boxWidth / 2, point.y + 7);
      ctx.font = '400 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      wrapCanvasText(ctx, context, point.x - boxWidth / 2, point.y + 31, boxWidth, 18, 2);
    });

    workstreamNodes.forEach((node) => {
      const point = exportCoordinates(node, width, height, margin);
      const name = node.querySelector('.workstream-name')?.textContent?.trim() || '';
      const status = node.querySelector('.workstream-status')?.textContent?.trim() || '';
      ctx.strokeStyle = 'rgba(17,17,17,.24)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(point.x - 90, point.y - 20);
      ctx.lineTo(point.x + 90, point.y - 20);
      ctx.stroke();
      ctx.fillStyle = '#111111';
      ctx.font = '500 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText(name, point.x - 90, point.y - 12);
      ctx.fillStyle = '#686864';
      ctx.font = '400 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText(status, point.x - 90, point.y + 12);
    });

    [...els.stage.querySelectorAll('.ecosystem-object')].forEach((node) => {
      const point = exportCoordinates(node, width, height, margin);
      const label = node.textContent?.replace(/\s+/g, ' ')?.trim() || '';
      ctx.fillStyle = '#f7f7f2';
      ctx.strokeStyle = 'rgba(17,17,17,.22)';
      ctx.lineWidth = 1;
      ctx.fillRect(point.x - 72, point.y - 16, 144, 32);
      ctx.strokeRect(point.x - 72, point.y - 16, 144, 32);
      ctx.fillStyle = '#686864';
      ctx.font = '500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText(label.slice(0, 22), point.x - 60, point.y - 7);
    });

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG export could not be generated');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `projecttt-portfolio-map-${new Date().toISOString().slice(0, 10)}.png`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    console.error(error);
  } finally {
    if (trigger) {
      trigger.disabled = false;
      trigger.textContent = originalText || 'Download';
    }
  }
}

function syncEnhancements() {
  const selectedId = selectedProjectId();
  if (selectedId !== lastSelectedProjectId) {
    if (expandedProjectId && expandedProjectId !== selectedId) expandedProjectId = null;
    lastSelectedProjectId = selectedId;
  }
  renderExpandedWorkstreams();
  decorateDrawer();
  decorateContextLogos();
  decorateGridLogos();
  queueRelationshipSync();
}

function bindObservers() {
  const observer = new MutationObserver(() => requestAnimationFrame(syncEnhancements));
  if (els.stage) observer.observe(els.stage, { childList: true, subtree: false });
  if (els.drawerContent) observer.observe(els.drawerContent, { childList: true, subtree: true });
  if (els.ecosystemGrid) observer.observe(els.ecosystemGrid, { childList: true, subtree: false });

  window.addEventListener('resize', () => {
    if (mobileQuery.matches) fitAll();
    else queueRelationshipSync();
  });
  mobileQuery.addEventListener('change', () => {
    viewport.pointers.clear();
    viewport.panStart = null;
    viewport.pinchStart = null;
    if (mobileQuery.matches) fitAll();
    else resetViewport();
    syncEnhancements();
  });
}

async function bootEnhancements() {
  if (!els.frame || !els.stage || !els.relationships) return;
  try {
    const response = await fetch(SNAPSHOT_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Enhancement snapshot request failed with ${response.status}`);
    snapshot = await response.json();
    buildViewportControls();
    bindViewportGestures();
    bindObservers();
    syncEnhancements();
    requestAnimationFrame(() => {
      if (mobileQuery.matches) fitAll();
      else resetViewport();
    });
  } catch (error) {
    console.error(error);
  }
}

bootEnhancements();

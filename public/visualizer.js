window.InventoryVisualizer = (() => {
  function create(config) {
    const {
      vizForm,
      vizProjectSelect,
      vizResetBtn,
      vizCloseBtn,
      vizStage,
      vizWires,
      vizNodes,
      vizConnections,
      getItems,
      getProjectOptions,
      setVizVisible,
      itemLabel,
      segmentLabel,
      sideLabel,
      loadProjects
    } = config;

    let vizDragging = null;
    let vizResizing = null;
    let vizProject = '';
    let vizWireDragSource = null;
    let vizLegendPopover = null;

    // Schematic data (layout, connections, splits) is shared across collaborators via the
    // server instead of localStorage. An in-memory cache per project backs synchronous reads
    // during render/drag; it's populated lazily on first use (see ensureVizDataLoaded) and
    // pushed back to the server with a short debounce so rapid drag/resize edits collapse
    // into a single request instead of one per pointermove.
    let vizDataCache = {};
    let vizDataLoadPromises = {};
    let vizSaveTimers = {};

    function emptyVizData() {
      return { layout: {}, connections: [], splits: {}, legend: [] };
    }

    function ensureVizDataLoaded(project) {
      if (vizDataCache[project]) return Promise.resolve(vizDataCache[project]);
      if (vizDataLoadPromises[project]) return vizDataLoadPromises[project];
      vizDataLoadPromises[project] = fetch(`/api/viz/${encodeURIComponent(project)}`)
        .then((res) => (res.ok ? res.json() : emptyVizData()))
        .catch(() => emptyVizData())
        .then((data) => {
          const connections = Array.isArray(data && data.connections)
            ? data.connections.filter((link) => link && typeof link.from === 'string' && typeof link.to === 'string' && link.from !== link.to)
            : [];
          const legend = Array.isArray(data && data.legend)
            ? data.legend.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.color === 'string')
            : [];
          vizDataCache[project] = {
            layout: (data && data.layout) || {},
            connections,
            splits: (data && data.splits) || {},
            legend
          };
          delete vizDataLoadPromises[project];
          return vizDataCache[project];
        });
      return vizDataLoadPromises[project];
    }

    function scheduleVizSave(project) {
      if (vizSaveTimers[project]) clearTimeout(vizSaveTimers[project]);
      vizSaveTimers[project] = setTimeout(() => {
        delete vizSaveTimers[project];
        const payload = vizDataCache[project] || emptyVizData();
        fetch(`/api/viz/${encodeURIComponent(project)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(() => {});
      }, 400);
    }

    function getVizLayout(project) {
      return (vizDataCache[project] && vizDataCache[project].layout) || {};
    }

    function saveVizLayout(project, layout) {
      vizDataCache[project] = vizDataCache[project] || emptyVizData();
      vizDataCache[project].layout = layout;
      scheduleVizSave(project);
    }

    function getVizConnections(project) {
      return (vizDataCache[project] && vizDataCache[project].connections) || [];
    }

    function saveVizConnections(project, connections) {
      vizDataCache[project] = vizDataCache[project] || emptyVizData();
      vizDataCache[project].connections = connections;
      scheduleVizSave(project);
    }

    function getVizSplits(project) {
      return (vizDataCache[project] && vizDataCache[project].splits) || {};
    }

    function saveVizSplits(project, splits) {
      vizDataCache[project] = vizDataCache[project] || emptyVizData();
      vizDataCache[project].splits = splits;
      scheduleVizSave(project);
    }

    const DEFAULT_WIRE_COLOR = '#4a5568';

    function getVizLegend(project) {
      return (vizDataCache[project] && vizDataCache[project].legend) || [];
    }

    function saveVizLegend(project, legend) {
      vizDataCache[project] = vizDataCache[project] || emptyVizData();
      vizDataCache[project].legend = legend;
      scheduleVizSave(project);
    }

    function generateLegendId() {
      return `lg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    function addLegendEntry(project, name, color) {
      const legend = getVizLegend(project);
      const entry = { id: generateLegendId(), name: (name || 'Untitled').trim() || 'Untitled', color: color || DEFAULT_WIRE_COLOR };
      legend.push(entry);
      saveVizLegend(project, legend);
      return entry;
    }

    function updateLegendEntry(project, id, patch) {
      const legend = getVizLegend(project);
      const entry = legend.find((e) => e.id === id);
      if (!entry) return null;
      if (typeof patch.name === 'string') entry.name = patch.name.trim() || entry.name;
      if (typeof patch.color === 'string') entry.color = patch.color;
      saveVizLegend(project, legend);
      return entry;
    }

    function removeLegendEntry(project, id) {
      const legend = getVizLegend(project).filter((e) => e.id !== id);
      const connections = getVizConnections(project).map((c) => (c.legendId === id ? { ...c, legendId: null } : c));
      saveVizLegend(project, legend);
      saveVizConnections(project, connections);
      renderVisualizer();
    }

    function colorForConnection(project, connection) {
      if (!connection || !connection.legendId) return DEFAULT_WIRE_COLOR;
      const entry = getVizLegend(project).find((e) => e.id === connection.legendId);
      return entry ? entry.color : DEFAULT_WIRE_COLOR;
    }

    function getNodeSplitCount(project, itemId) {
      const splits = getVizSplits(project);
      const value = Number(splits[itemId]);
      return Number.isFinite(value) && value > 1 ? Math.floor(value) : 1;
    }

    function setNodeSplitCount(project, itemId, count) {
      const splits = getVizSplits(project);
      if (!Number.isFinite(count) || count <= 1) delete splits[itemId];
      else splits[itemId] = Math.floor(count);
      saveVizSplits(project, splits);
    }

    function clearNodeSplit(project, itemId) {
      const splits = getVizSplits(project);
      if (splits[itemId] !== undefined) {
        delete splits[itemId];
        saveVizSplits(project, splits);
      }
    }

    // Inline stepper popover replacing window.prompt() for choosing a split count.
    let vizSplitPopover = null;

    function closeSplitPopover() {
      if (!vizSplitPopover) return;
      vizSplitPopover.remove();
      vizSplitPopover = null;
      document.removeEventListener('pointerdown', handleSplitPopoverOutsideClick, true);
    }

    function handleSplitPopoverOutsideClick(ev) {
      if (vizSplitPopover && !vizSplitPopover.contains(ev.target)) closeSplitPopover();
    }

    function openSplitPopover(anchorEl, targetId) {
      if (!vizStage) return;
      closeSplitPopover();
      let count = getNodeSplitCount(vizProject, targetId) || 1;
      const pop = document.createElement('div');
      pop.className = 'viz-split-popover';
      pop.innerHTML = `
        <div class="viz-split-popover-label">Segments</div>
        <div class="viz-split-popover-row">
          <button type="button" class="viz-split-dec" aria-label="Decrease">−</button>
          <span class="viz-split-count">${count}</span>
          <button type="button" class="viz-split-inc" aria-label="Increase">+</button>
        </div>
        <div class="viz-split-popover-actions">
          <button type="button" class="viz-split-apply">Apply</button>
        </div>
      `;
      vizStage.appendChild(pop);
      const anchorRect = anchorEl.getBoundingClientRect();
      const stageRect = vizStage.getBoundingClientRect();
      pop.style.left = `${(anchorRect.left - stageRect.left + vizStage.scrollLeft) / Math.max(zoom, 0.0001)}px`;
      pop.style.top = `${(anchorRect.bottom - stageRect.top + vizStage.scrollTop) / Math.max(zoom, 0.0001) + 6}px`;

      const countEl = pop.querySelector('.viz-split-count');
      pop.querySelector('.viz-split-dec').addEventListener('click', (e) => {
        e.stopPropagation();
        count = Math.max(1, count - 1);
        countEl.textContent = String(count);
      });
      pop.querySelector('.viz-split-inc').addEventListener('click', (e) => {
        e.stopPropagation();
        count = Math.min(12, count + 1);
        countEl.textContent = String(count);
      });
      pop.querySelector('.viz-split-apply').addEventListener('click', (e) => {
        e.stopPropagation();
        setNodeSplitCount(vizProject, targetId, count);
        closeSplitPopover();
        renderVisualizer();
      });
      pop.addEventListener('pointerdown', (e) => e.stopPropagation());
      setTimeout(() => document.addEventListener('pointerdown', handleSplitPopoverOutsideClick, true), 0);
      vizSplitPopover = pop;
    }

    // Popover for assigning/creating a wire's legend category — opened right after drawing a
    // new connection, or by clicking an existing wire or its row in the connections list.
    function closeLegendPopover() {
      if (!vizLegendPopover) return;
      vizLegendPopover.remove();
      vizLegendPopover = null;
      document.removeEventListener('pointerdown', handleLegendPopoverOutsideClick, true);
    }

    function handleLegendPopoverOutsideClick(ev) {
      if (vizLegendPopover && !vizLegendPopover.contains(ev.target)) closeLegendPopover();
    }

    function openLegendPopover(project, connectionIndex, clientPoint) {
      if (!vizStage) return;
      closeSplitPopover();
      closeLegendPopover();
      const legend = getVizLegend(project);
      const connections = getVizConnections(project);
      const current = connections[connectionIndex];
      if (!current) return;

      const pop = document.createElement('div');
      pop.className = 'viz-legend-popover';
      pop.innerHTML = `
        <div class="viz-legend-popover-label">Wire category</div>
        <div class="viz-legend-popover-options">
          <button type="button" class="viz-legend-option${!current.legendId ? ' active' : ''}" data-legend-option="">
            <span class="legend-swatch" style="background:${DEFAULT_WIRE_COLOR}"></span>No category
          </button>
          ${legend.map((entry) => `
            <button type="button" class="viz-legend-option${current.legendId === entry.id ? ' active' : ''}" data-legend-option="${entry.id}">
              <span class="legend-swatch" style="background:${entry.color}"></span>${entry.name}
            </button>
          `).join('')}
        </div>
        <form class="viz-legend-new-form">
          <input type="text" class="viz-legend-new-name" placeholder="New category" maxlength="40" required>
          <input type="color" class="viz-legend-new-color" value="${DEFAULT_WIRE_COLOR}">
          <button type="submit">+</button>
        </form>
      `;
      vizStage.appendChild(pop);
      const stageRect = vizStage.getBoundingClientRect();
      pop.style.left = `${(clientPoint.x - stageRect.left + vizStage.scrollLeft) / Math.max(zoom, 0.0001)}px`;
      pop.style.top = `${(clientPoint.y - stageRect.top + vizStage.scrollTop) / Math.max(zoom, 0.0001) + 10}px`;

      function assignAndClose(legendId) {
        const conns = getVizConnections(project);
        if (conns[connectionIndex]) conns[connectionIndex] = { ...conns[connectionIndex], legendId };
        saveVizConnections(project, conns);
        closeLegendPopover();
        renderVisualizer();
      }

      pop.querySelectorAll('[data-legend-option]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          assignAndClose(btn.dataset.legendOption || null);
        });
      });
      pop.querySelector('.viz-legend-new-form').addEventListener('submit', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nameInput = pop.querySelector('.viz-legend-new-name');
        const colorInput = pop.querySelector('.viz-legend-new-color');
        if (!nameInput.value.trim()) return;
        const entry = addLegendEntry(project, nameInput.value, colorInput.value);
        assignAndClose(entry.id);
      });
      pop.addEventListener('pointerdown', (e) => e.stopPropagation());
      setTimeout(() => document.addEventListener('pointerdown', handleLegendPopoverOutsideClick, true), 0);
      vizLegendPopover = pop;
    }

    function addVizConnection(project, from, to, fromPart = null, toPart = null, fromSide = null, toSide = null, legendId = null) {
      if (!from || !to || from === to) return -1;
      const connections = getVizConnections(project);
      if (connections.some((link) => link.from === from && link.to === to && link.fromPart === fromPart && link.toPart === toPart && link.fromSide === fromSide && link.toSide === toSide)) return -1;
      connections.push({ from, to, fromPart, toPart, fromSide, toSide, legendId });
      saveVizConnections(project, connections);
      return connections.length - 1;
    }

    function removeVizConnection(project, index) {
      const connections = getVizConnections(project);
      if (index < 0 || index >= connections.length) return;
      connections.splice(index, 1);
      saveVizConnections(project, connections);
    }

    function sanitizeVizConnections(project, validIds) {
      const current = getVizConnections(project);
      const validLegendIds = new Set(getVizLegend(project).map((e) => e.id));
      let legendChanged = false;
      const filtered = current.filter((link) => {
        if (!validIds.has(link.from) || !validIds.has(link.to)) return false;
        const fromParts = getNodeSplitCount(project, link.from);
        const toParts = getNodeSplitCount(project, link.to);
        if (Number.isInteger(link.fromPart) && (link.fromPart < 0 || link.fromPart >= fromParts)) return false;
        if (Number.isInteger(link.toPart) && (link.toPart < 0 || link.toPart >= toParts)) return false;
        if (link.fromSide && !['left', 'right'].includes(link.fromSide)) return false;
        if (link.toSide && !['left', 'right'].includes(link.toSide)) return false;
        if (link.legendId && !validLegendIds.has(link.legendId)) { link.legendId = null; legendChanged = true; }
        return true;
      });
      if (filtered.length !== current.length || legendChanged) saveVizConnections(project, filtered);
      return filtered;
    }

    // Compatibility fallbacks for any stale app.js code paths that still expect these helpers globally.
    if (!window.sanitizeVizConnections) window.sanitizeVizConnections = sanitizeVizConnections;
    if (!window.getVizConnections) window.getVizConnections = getVizConnections;
    if (!window.saveVizConnections) window.saveVizConnections = saveVizConnections;
    if (!window.getVizLayout) window.getVizLayout = getVizLayout;
    if (!window.saveVizLayout) window.saveVizLayout = saveVizLayout;
    if (!window.getVizSplits) window.getVizSplits = getVizSplits;
    if (!window.saveVizSplits) window.saveVizSplits = saveVizSplits;
    if (!window.getNodeSplitCount) window.getNodeSplitCount = getNodeSplitCount;
    if (!window.setNodeSplitCount) window.setNodeSplitCount = setNodeSplitCount;
    if (!window.clearNodeSplit) window.clearNodeSplit = clearNodeSplit;

    function selectedVizProject() {
      const vizProjects = getVizProjects();
      return vizProjectSelect && vizProjectSelect.value ? vizProjectSelect.value : (vizProjects[0] || '');
    }

    function getVizProjects() {
      return getProjectOptions().filter((project) => project && project !== 'general');
    }

    function buildVisualizerNodes(project) {
      if (!project || project === 'general') return [];
      const projectItems = getItems()
        .filter((item) => item.project === project)
        .slice()
        .sort((a, b) => {
          const left = `${a.storagePlace || ''}:${a.name || ''}`.toLowerCase();
          const right = `${b.storagePlace || ''}:${b.name || ''}`.toLowerCase();
          if (left < right) return -1;
          if (left > right) return 1;
          return 0;
        });
      const layout = getVizLayout(project);
      const nodes = [];
      const gapX = 210;
      const gapY = 120;

      let positionIndex = 0;
      projectItems.forEach((item) => {
        const splitCount = getNodeSplitCount(project, item.id);
        // If user explicitly split the item, keep the single node with segments
        if (splitCount > 1) {
          const saved = layout[item.id] || {};
          const row = Math.floor(positionIndex / 3);
          const col = positionIndex % 3;
          const defaultWidth = 180;
          const minWidth = 160;
          const defaultHeight = 82 + (splitCount - 1) * 26;
          const minHeight = Math.max(70, 44 + splitCount * 24);
          nodes.push({
            item,
            x: Number.isFinite(saved.x) ? saved.x : 30 + col * gapX,
            y: Number.isFinite(saved.y) ? saved.y : 30 + row * gapY,
            width: Number.isFinite(saved.width) ? Math.max(minWidth, saved.width) : defaultWidth,
            height: Number.isFinite(saved.height) ? Math.max(minHeight, saved.height) : defaultHeight,
            splitCount,
            missing: Number(item.amount) <= 0,
            isInstance: false,
            baseId: item.id
          });
          positionIndex += 1;
          return;
        }

        // Otherwise, expand physical quantity into separate boxes
        const qty = Math.max(1, Number(item.amount) || 1);
        for (let i = 0; i < qty; i += 1) {
          const instanceId = `${item.id}#${i + 1}`;
          const saved = layout[instanceId] || {};
          const row = Math.floor(positionIndex / 3);
          const col = positionIndex % 3;
          const defaultWidth = 180;
          const minWidth = 160;
          const defaultHeight = 82;
          const minHeight = 70;
          const itemCopy = { ...item, id: instanceId, amount: 1, name: `${item.name || 'Item'} (${i + 1}/${qty})` };
          nodes.push({
            item: itemCopy,
            x: Number.isFinite(saved.x) ? saved.x : 30 + col * gapX,
            y: Number.isFinite(saved.y) ? saved.y : 30 + row * gapY,
            width: Number.isFinite(saved.width) ? Math.max(minWidth, saved.width) : defaultWidth,
            height: Number.isFinite(saved.height) ? Math.max(minHeight, saved.height) : defaultHeight,
            splitCount: 1,
            missing: Number(item.amount) <= 0,
            isInstance: true,
            baseId: item.id
          });
          positionIndex += 1;
        }
      });

      return nodes;
    }

    function applyNodeSegmentHeights(el, height, splitCount) {
      if (!el) return;
      const parts = Math.max(1, splitCount || 1);
      const segmentHeight = Math.max(20, Math.floor((height - 48) / parts));
      el.querySelectorAll('.viz-segment').forEach((segment) => {
        segment.style.height = `${segmentHeight}px`;
      });
    }

    function minVizNodeHeight(splitCount) {
      const parts = Math.max(1, splitCount || 1);
      return Math.max(70, 44 + parts * 24);
    }

      // Stable palette keyed by item type, so nodes of the same kind read as the same
      // color at a glance instead of each getting an arbitrary per-id hue.
      const TYPE_COLOR_PALETTE = {
        'wire roll': 'hsl(35 70% 65%)',
        'cable': 'hsl(200 65% 68%)',
        'speaker': 'hsl(150 50% 60%)',
        'microphone': 'hsl(280 50% 72%)',
        'micro-controller': 'hsl(10 65% 68%)',
        'instrument': 'hsl(50 70% 65%)',
        'diverse': 'hsl(0 0% 70%)'
      };

      function colorForType(type) {
        const key = String(type || '').toLowerCase().trim();
        if (TYPE_COLOR_PALETTE[key]) return TYPE_COLOR_PALETTE[key];
        let h = 0;
        for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 360;
        return `hsl(${h} 55% 70%)`;
      }

      function renderNodeSegments(node) {
        const parts = Math.max(1, node.splitCount || 1);
        const segmentHeight = Math.max(20, Math.floor((node.height - 48) / parts));
        if (parts === 1) {
          const label = node.item.name || `Item ${node.item.id}`;
          return `
            <div class="viz-single-segment" data-segment-index="0" style="height:${segmentHeight}px">
              <button type="button" class="viz-dot left" data-connector-dot="1" data-dot-side="left" data-segment-index="0" aria-label="Connect from left dot"></button>
              <span class="viz-segment-label">${label}</span>
              <button type="button" class="viz-dot right" data-connector-dot="1" data-dot-side="right" data-segment-index="0" aria-label="Connect from right dot"></button>
            </div>
          `;
        }

        const fragments = [];
        for (let index = 0; index < parts; index += 1) {
          const label = `Segment ${index + 1}`;
          fragments.push(`
            <div class="viz-segment" data-segment-index="${index}" style="height:${segmentHeight}px">
              <button type="button" class="viz-dot left" data-connector-dot="1" data-dot-side="left" data-segment-index="${index}" aria-label="Connect from left dot"></button>
              <span class="viz-segment-label">${label}</span>
              <button type="button" class="viz-dot right" data-connector-dot="1" data-dot-side="right" data-segment-index="${index}" aria-label="Connect from right dot"></button>
            </div>
          `);
        }
        return fragments.join('');
      }

      // Zoom state and helpers
      let zoom = 1;
      const ZOOM_MIN = 0.3;
      const ZOOM_MAX = 3;
      const ZOOM_STEP = 0.1;

      function canvasSizeFromNodes(nodes) {
        const size = { width: 1200, height: 800 };
        for (const node of nodes || []) {
          size.width = Math.max(size.width, node.x + node.width + 160);
          size.height = Math.max(size.height, node.y + node.height + 160);
        }
        return size;
      }

      function applyZoom() {
        if (!vizStage) return;
        const worldSize = canvasSizeFromNodes(vizLastNodes || []);
        // ensure spacer exists
        let spacer = vizStage.querySelector('.viz-canvas-spacer');
        if (!spacer) {
          spacer = document.createElement('div');
          spacer.className = 'viz-canvas-spacer';
          spacer.style.position = 'absolute';
          spacer.style.left = '0';
          spacer.style.top = '0';
          spacer.style.pointerEvents = 'none';
          vizStage.insertBefore(spacer, vizNodes);
        }
        const stageRect = vizStage.getBoundingClientRect();
        // spacer represents the logical canvas size (bigger when zoomed out)
        const logicalW = Math.max(800, Math.round(Math.max(worldSize.width, stageRect.width / Math.max(zoom, 0.01))));
        const logicalH = Math.max(600, Math.round(Math.max(worldSize.height, stageRect.height / Math.max(zoom, 0.01))));
        spacer.style.width = `${logicalW}px`;
        spacer.style.height = `${logicalH}px`;
        // transform nodes and wires together in the same world coordinate space
        if (vizNodes) {
          vizNodes.style.transform = `scale(${zoom})`;
          vizNodes.style.transformOrigin = '0 0';
        }
        if (vizWires) {
          vizWires.style.transform = `scale(${zoom})`;
          vizWires.style.transformOrigin = '0 0';
          vizWires.style.width = `${logicalW}px`;
          vizWires.style.height = `${logicalH}px`;
          vizWires.setAttribute('viewBox', `0 0 ${logicalW} ${logicalH}`);
        }
      }

      // `anchor` (client coordinates) keeps the point under the cursor visually fixed
      // while zooming, instead of always zooming toward the stage's top-left corner.
      function setZoomLevel(level, anchor) {
        const prevZoom = zoom;
        const nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
        if (anchor && vizStage && nextZoom !== prevZoom) {
          const stageRect = vizStage.getBoundingClientRect();
          const localX = anchor.x - stageRect.left + vizStage.scrollLeft;
          const localY = anchor.y - stageRect.top + vizStage.scrollTop;
          const worldX = localX / Math.max(prevZoom, 0.0001);
          const worldY = localY / Math.max(prevZoom, 0.0001);
          zoom = nextZoom;
          applyZoom();
          vizStage.scrollLeft = worldX * zoom - (anchor.x - stageRect.left);
          vizStage.scrollTop = worldY * zoom - (anchor.y - stageRect.top);
        } else {
          zoom = nextZoom;
          applyZoom();
        }
        scheduleRedraw();
      }

      function zoomIn(anchor) { setZoomLevel(zoom + ZOOM_STEP, anchor); }
      function zoomOut(anchor) { setZoomLevel(zoom - ZOOM_STEP, anchor); }
      function zoomReset() { setZoomLevel(1); }

      function fitToView() {
        if (!vizStage) return;
        const nodes = vizLastNodes || [];
        if (!nodes.length) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of nodes) {
          minX = Math.min(minX, n.x);
          minY = Math.min(minY, n.y);
          maxX = Math.max(maxX, n.x + n.width);
          maxY = Math.max(maxY, n.y + n.height);
        }
        const contentW = Math.max(1, maxX - minX);
        const contentH = Math.max(1, maxY - minY);
        const stageRect = vizStage.getBoundingClientRect();
        const padding = 60;
        const scaleX = (stageRect.width - padding) / contentW;
        const scaleY = (stageRect.height - padding) / contentH;
        zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(scaleX, scaleY)));
        applyZoom();
        vizStage.scrollLeft = Math.max(0, minX * zoom - padding / 2);
        vizStage.scrollTop = Math.max(0, minY * zoom - padding / 2);
        scheduleRedraw();
      }

      // debounced rAF redraw for wires/pan (used for scroll/window-resize, where a little latency is fine)
      let vizLastNodes = null;
      let vizLastConnections = null;
      let _rafId = null;
      let _debounceTimer = null;
      let _scrollRaf = null;
      function scheduleRedraw() {
        if (_debounceTimer) clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => {
          if (_rafId) cancelAnimationFrame(_rafId);
          _rafId = requestAnimationFrame(() => {
            try { updateWireLayer(vizProject, vizLastNodes || [], vizLastConnections || []); } catch (e) { /* ignore */ }
            _rafId = null;
          });
        }, 50);
      }

      // rAF-coalesced (no setTimeout debounce) redraw for active drag/resize, so wires
      // track the pointer at up to one recalculation per frame instead of once per pixel.
      let _dragRafId = null;
      let _dragPendingNodes = null;
      let _dragPendingConnections = null;
      function requestWireUpdate(nodes, connections) {
        vizLastNodes = _dragPendingNodes = nodes;
        vizLastConnections = _dragPendingConnections = connections;
        if (_dragRafId) return;
        _dragRafId = requestAnimationFrame(() => {
          try { updateWireLayer(vizProject, _dragPendingNodes || [], _dragPendingConnections || []); } catch (e) { /* ignore */ }
          _dragRafId = null;
        });
      }

      function getAnchorForNode(node, partIndex, side) {
        if (!node || !vizStage) return null;
        const stageRect = vizStage.getBoundingClientRect();
        // If requested part index is invalid, use center of node in world coordinates.
        if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= Math.max(1, node.splitCount || 1)) {
          return {
            x: node.x + node.width / 2,
            y: node.y + node.height / 2
          };
        }
        const segs = vizNodes ? vizNodes.querySelectorAll(`[data-item-id="${node.item.id}"] .viz-segment, [data-item-id="${node.item.id}"] .viz-single-segment`) : [];
        const segment = segs[partIndex];
        if (!segment) {
          return {
            x: node.x + node.width / 2,
            y: node.y + node.height / 2
          };
        }
        const rect = segment.getBoundingClientRect();
        const scrollLeft = vizStage.scrollLeft || 0;
        const scrollTop = vizStage.scrollTop || 0;
        return {
          x: ((side === 'left' ? rect.left : side === 'right' ? rect.right : rect.left + rect.width / 2) - stageRect.left + scrollLeft) / Math.max(zoom, 0.0001),
          y: (rect.top - stageRect.top + rect.height / 2 + scrollTop) / Math.max(zoom, 0.0001)
        };
      }

    function updateWireLayer(project, nodes, connections) {
      if (!vizWires || !vizStage) return;
      const stageRect = vizStage.getBoundingClientRect();
      const canvasSize = canvasSizeFromNodes(nodes);
      vizWires.innerHTML = '';
      const width = canvasSize.width || stageRect.width || 0;
      const height = canvasSize.height || stageRect.height || 0;
      vizWires.style.width = `${width}px`;
      vizWires.style.height = `${height}px`;
      vizWires.setAttribute('viewBox', `0 0 ${width} ${height}`);
      vizWires.setAttribute('preserveAspectRatio', 'none');

      if (!nodes.length || !connections.length) return;

      const nodeMap = new Map(nodes.map((node) => [node.item.id, node]));
      connections.forEach((connection, index) => {
        const source = nodeMap.get(connection.from);
        const target = nodeMap.get(connection.to);
        if (!source || !target) return;
        const start = getAnchorForNode(source, connection.fromPart, connection.fromSide);
        const end = getAnchorForNode(target, connection.toPart, connection.toSide);
        const startX = start.x;
        const startY = start.y;
        const endX = end.x;
        const endY = end.y;
        const bend = Math.max(70, Math.abs(endX - startX) * 0.35);
        const d = `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', colorForConnection(project, connection));
        path.setAttribute('stroke-width', '2');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('pointer-events', 'none');
        vizWires.appendChild(path);

        // Wider, invisible path purely for click hit-testing — the visible stroke above is
        // only 2px, too thin to click reliably.
        const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hit.setAttribute('d', d);
        hit.setAttribute('fill', 'none');
        hit.setAttribute('stroke', 'transparent');
        hit.setAttribute('stroke-width', '14');
        hit.setAttribute('pointer-events', 'stroke');
        hit.classList.add('viz-wire-hit');
        hit.dataset.connectionIndex = String(index);
        vizWires.appendChild(hit);
      });
    }

    let vizGhostPointer = null;
    let _ghostRafId = null;

    function updateGhostWire() {
      if (!vizWires || !vizStage) return;
      let ghost = vizWires.querySelector('.viz-ghost-wire');
      if (!vizWireDragSource || !vizGhostPointer) {
        if (ghost) ghost.remove();
        return;
      }
      const sourceNode = (vizLastNodes || []).find((n) => n.item.id === vizWireDragSource.id);
      if (!sourceNode) {
        if (ghost) ghost.remove();
        return;
      }
      const start = getAnchorForNode(sourceNode, vizWireDragSource.part, vizWireDragSource.side);
      const stageRect = vizStage.getBoundingClientRect();
      const end = {
        x: (vizGhostPointer.x - stageRect.left + vizStage.scrollLeft) / Math.max(zoom, 0.0001),
        y: (vizGhostPointer.y - stageRect.top + vizStage.scrollTop) / Math.max(zoom, 0.0001)
      };
      if (!ghost) {
        ghost = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        ghost.setAttribute('class', 'viz-ghost-wire');
        ghost.setAttribute('fill', 'none');
        ghost.setAttribute('stroke', '#2b6cb0');
        ghost.setAttribute('stroke-width', '2');
        ghost.setAttribute('stroke-dasharray', '6 4');
        ghost.setAttribute('stroke-linecap', 'round');
        vizWires.appendChild(ghost);
      }
      const bend = Math.max(70, Math.abs(end.x - start.x) * 0.35);
      ghost.setAttribute('d', `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`);
    }

    function scheduleGhostWire() {
      if (_ghostRafId) return;
      _ghostRafId = requestAnimationFrame(() => {
        updateGhostWire();
        _ghostRafId = null;
      });
    }

    function renderConnectionList(project, nodes, connections) {
      if (!vizConnections) return;
      const nodeMap = new Map(nodes.map((node) => [node.item.id, node.item]));
      if (!connections.length) {
        vizConnections.innerHTML = '<div class="viz-empty">No connections yet. Drag from one box\'s dot to another to link them.</div>';
        return;
      }
      vizConnections.innerHTML = '';
      connections.forEach((connection, index) => {
        const row = document.createElement('div');
        row.className = 'viz-connection-row';
        const sourceItem = nodeMap.get(connection.from);
        const targetItem = nodeMap.get(connection.to);
        row.innerHTML = `
          <div class="viz-connection-row-main" data-connection-index="${index}">
            <span class="legend-swatch" style="background:${colorForConnection(project, connection)}"></span>
            ${itemLabel(sourceItem)} (${segmentLabel(connection.fromPart)}, ${sideLabel(connection.fromSide)}) → ${itemLabel(targetItem)} (${segmentLabel(connection.toPart)}, ${sideLabel(connection.toSide)})
          </div>
          <button type="button" data-connection-index="${index}">Remove</button>
        `;
        vizConnections.appendChild(row);
      });
    }

    function renderWireLegendPanel(project) {
      const panel = document.getElementById('vizLegendList');
      if (!panel) return;
      const legend = getVizLegend(project);
      panel.innerHTML = legend.length ? '' : '<div class="viz-empty">No categories yet.</div>';
      legend.forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'viz-connection-row viz-legend-row';
        row.innerHTML = `
          <input type="color" class="viz-legend-row-color" value="${entry.color}" data-legend-id="${entry.id}">
          <input type="text" class="viz-legend-row-name" value="${entry.name}" data-legend-id="${entry.id}" maxlength="40">
          <button type="button" data-remove-legend="${entry.id}">Delete</button>
        `;
        panel.appendChild(row);
      });
    }

    function renderTypeLegend(nodes) {
      const legend = document.getElementById('vizTypeLegend');
      if (!legend) return;
      const types = Array.from(new Set(nodes.map((n) => n.item.type || 'unknown'))).sort();
      legend.innerHTML = types.map((t) => `
        <span class="legend-item"><span class="legend-swatch" style="background:${colorForType(t)}"></span>${t}</span>
      `).join('');
    }

    function renderVisualizer() {
      if (!vizNodes || !vizProjectSelect) return;
      closeSplitPopover();
      closeLegendPopover();
      vizProject = selectedVizProject();
      const projectNodes = buildVisualizerNodes(vizProject);
      const activeIds = new Set(projectNodes.map((node) => node.item.id));
      const connections = sanitizeVizConnections(vizProject, activeIds);
      vizNodes.innerHTML = '';
      renderTypeLegend(projectNodes);

      if (!projectNodes.length) {
        vizNodes.innerHTML = '<div class="viz-empty">No items found for this project yet. Add items to see the schematic.</div>';
        renderConnectionList(vizProject, [], []);
        renderWireLegendPanel(vizProject);
        updateWireLayer(vizProject, [], []);
        return;
      }

      const layout = getVizLayout(vizProject);
      for (const node of projectNodes) {
        const el = document.createElement('div');
        el.className = `viz-node ${node.missing ? 'missing' : 'available'}`;
        el.dataset.itemId = node.item.id;
        el.style.left = `${node.x}px`;
        el.style.top = `${node.y}px`;
        el.style.width = `${node.width}px`;
        el.style.height = `${node.height}px`;
        el.innerHTML = `
          <div class="viz-name">${node.item.name || 'Unnamed item'}</div>
          <div class="viz-meta">Storage: ${node.item.storagePlace || 'general'}</div>
          <div class="viz-meta">Amount: ${(node.isInstance || !window.InventoryUtil.hasQuantityGoal(node.item.project)) ? (node.item.amount || 0) : `${node.item.amount || 0}/${Number.isFinite(Number(node.item.needed)) ? node.item.needed : (node.item.amount || 0)}`}</div>
          <div class="viz-meta">Type: ${node.item.type || 'unknown'}</div>
          ${node.item.splitFrom ? `<div class="viz-meta">Split piece from ${node.item.splitFrom}</div>` : ''}
          <div class="viz-segments">${renderNodeSegments(node)}</div>
          <div class="viz-chip">${node.missing ? 'missing' : 'connected'}</div>
          <div class="viz-node-actions">
            ${!node.isInstance ? `<button type="button" data-split-node="${node.baseId || node.item.id}">${node.splitCount > 1 ? 'Edit split' : 'Split'}</button>` : ''}
            ${!node.isInstance && node.splitCount > 1 ? `<button type="button" data-clear-split-node="${node.baseId || node.item.id}">Merge</button>` : ''}
          </div>
          <button type="button" class="viz-resize-handle" data-resize-handle="se" aria-label="Resize box"></button>
        `;

        applyNodeSegmentHeights(el, node.height, node.splitCount);
          // apply type-coded swatch color to node header
          const swatch = document.createElement('div');
          swatch.className = 'viz-swatch-unique';
          swatch.style.background = colorForType(node.item.type);
          const nameEl = el.querySelector('.viz-name');
          if (nameEl) nameEl.prepend(swatch);

        const resizeHandle = el.querySelector('button[data-resize-handle]');
        if (resizeHandle) {
          resizeHandle.addEventListener('pointerdown', (ev) => {
            if (!vizStage) return;
            ev.preventDefault();
            ev.stopPropagation();
            // Bound growth by the logical canvas size (plus headroom), not the visible
            // viewport — otherwise a node can never grow past whatever is on-screen right now.
            const worldSize = canvasSizeFromNodes(projectNodes);
            vizResizing = {
              id: node.item.id,
              startX: ev.clientX,
              startY: ev.clientY,
              originX: parseFloat(el.style.left) || 0,
              originY: parseFloat(el.style.top) || 0,
              originWidth: parseFloat(el.style.width) || node.width,
              originHeight: parseFloat(el.style.height) || node.height,
              minWidth: 160,
              minHeight: minVizNodeHeight(node.splitCount),
              splitCount: node.splitCount,
              element: el,
              stageWidth: worldSize.width + 2000,
              stageHeight: worldSize.height + 2000
            };
            try { resizeHandle.setPointerCapture(ev.pointerId); } catch (e) {}
            el.classList.add('resizing');
          });

          resizeHandle.addEventListener('pointermove', (ev) => {
            if (!vizResizing || vizResizing.id !== node.item.id || !vizStage) return;
            const dx = (ev.clientX - vizResizing.startX) / Math.max(zoom, 0.0001);
            const dy = (ev.clientY - vizResizing.startY) / Math.max(zoom, 0.0001);
            const nextWidth = Math.min(
              Math.max(vizResizing.minWidth, vizResizing.stageWidth - vizResizing.originX - 10),
              Math.max(vizResizing.minWidth, vizResizing.originWidth + dx)
            );
            const nextHeight = Math.min(
              Math.max(vizResizing.minHeight, vizResizing.stageHeight - vizResizing.originY - 10),
              Math.max(vizResizing.minHeight, vizResizing.originHeight + dy)
            );
            el.style.width = `${nextWidth}px`;
            el.style.height = `${nextHeight}px`;
            applyNodeSegmentHeights(el, nextHeight, node.splitCount);
            layout[node.item.id] = {
              ...(layout[node.item.id] || {}),
              width: nextWidth,
              height: nextHeight
            };
            requestWireUpdate(
              projectNodes.map((entry) => entry.item.id === node.item.id ? { ...entry, width: nextWidth, height: nextHeight } : entry),
              connections
            );
          });

          resizeHandle.addEventListener('pointerup', (ev) => {
            if (!vizResizing || vizResizing.id !== node.item.id) return;
            el.classList.remove('resizing');
            saveVizLayout(vizProject, layout);
            vizResizing = null;
            renderVisualizer();
            try { resizeHandle.releasePointerCapture(ev.pointerId); } catch (e) {}
          });
        }

        el.addEventListener('click', (ev) => {
          const splitBtn = ev.target.closest('button[data-split-node]');
          if (splitBtn) {
            openSplitPopover(splitBtn, splitBtn.dataset.splitNode);
            return;
          }
          const clearSplitBtn = ev.target.closest('button[data-clear-split-node]');
          if (clearSplitBtn) {
            const targetId = clearSplitBtn.dataset.clearSplitNode;
            clearNodeSplit(vizProject, targetId);
            renderVisualizer();
            return;
          }
        });

        el.addEventListener('pointerdown', (ev) => {
          if (ev.target.closest('button')) return;
          if (!vizStage) return;
          vizDragging = {
            id: node.item.id,
            startX: ev.clientX,
            startY: ev.clientY,
            originX: parseFloat(el.style.left) || 0,
            originY: parseFloat(el.style.top) || 0,
            element: el
          };
          el.setPointerCapture(ev.pointerId);
          el.classList.add('dragging');
        });

        el.addEventListener('pointermove', (ev) => {
          if (!vizDragging || vizDragging.id !== node.item.id || !vizStage) return;
          // Bound movement by the logical canvas size (plus headroom) rather than the
          // visible viewport, so a node can be dragged beyond what's on-screen right now —
          // the canvas grows to fit on the next render, and the user can scroll to follow it.
          const worldSize = canvasSizeFromNodes(projectNodes);
          const maxX = Math.max(0, worldSize.width + 2000 - node.width - 10);
          const maxY = Math.max(0, worldSize.height + 2000 - node.height - 10);
          const dx = (ev.clientX - vizDragging.startX) / Math.max(zoom, 0.0001);
          const dy = (ev.clientY - vizDragging.startY) / Math.max(zoom, 0.0001);
          const nextX = Math.min(maxX, Math.max(10, vizDragging.originX + dx));
          const nextY = Math.min(maxY, Math.max(10, vizDragging.originY + dy));
          el.style.left = `${nextX}px`;
          el.style.top = `${nextY}px`;
          layout[node.item.id] = {
            ...(layout[node.item.id] || {}),
            x: nextX,
            y: nextY
          };
          requestWireUpdate(projectNodes.map((entry) => entry.item.id === node.item.id ? { ...entry, x: nextX, y: nextY } : entry), connections);
        });

        el.addEventListener('pointerup', (ev) => {
          if (!vizDragging || vizDragging.id !== node.item.id) return;
          el.classList.remove('dragging');
          saveVizLayout(vizProject, layout);
          vizDragging = null;
          renderVisualizer();
          try { el.releasePointerCapture(ev.pointerId); } catch (e) {}
        });

        vizNodes.appendChild(el);
      }

      renderConnectionList(vizProject, projectNodes, connections);
      renderWireLegendPanel(vizProject);
      // save latest nodes/connections for redraws and zoom sizing
      vizLastNodes = projectNodes;
      vizLastConnections = connections;
      applyZoom();
      // immediate update; heavy debounced rAF redraw is only needed for zoom changes
      try { updateWireLayer(vizProject, vizLastNodes, vizLastConnections); } catch (e) {}
    }

    function openVisualizer() {
      const vizProjects = getVizProjects();
      if (!vizProjects.length) return alert('No non-general projects to visualize');
      if (vizProjectSelect && !vizProjectSelect.value) vizProjectSelect.value = vizProjects[0];
      vizProject = vizProjectSelect ? vizProjectSelect.value : vizProjects[0];
      setVizVisible(true);
      ensureVizDataLoaded(vizProject).then(renderVisualizer);
    }

    function closeVisualizer() {
      vizDragging = null;
      vizResizing = null;
      vizWireDragSource = null;
      vizGhostPointer = null;
      closeSplitPopover();
      closeLegendPopover();
      setVizVisible(false);
    }

    function resetVisualizerLayout() {
      const project = selectedVizProject();
      vizDataCache[project] = vizDataCache[project] || emptyVizData();
      vizDataCache[project].layout = {};
      scheduleVizSave(project);
      renderVisualizer();
    }

    function clearVisualizerConnections() {
      const project = selectedVizProject();
      if (!confirm('Clear all connections for this project?')) return;
      saveVizConnections(project, []);
      renderVisualizer();
    }

    function populateVisualizerProjects() {
      if (!vizProjectSelect) return;
      const vizProjects = getVizProjects();
      const current = vizProjectSelect.value || vizProject || vizProjects[0] || '';
      vizProjectSelect.innerHTML = '';
      if (!vizProjects.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No non-general projects';
        vizProjectSelect.appendChild(opt);
        vizProjectSelect.value = '';
        return;
      }
      for (const p of vizProjects) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        vizProjectSelect.appendChild(opt);
      }
      if (current && vizProjects.includes(current)) vizProjectSelect.value = current;
    }

    if (vizProjectSelect) {
      vizProjectSelect.addEventListener('change', () => {
        vizProject = vizProjectSelect.value;
        ensureVizDataLoaded(vizProject).then(renderVisualizer);
      });
    }

    if (vizResetBtn) vizResetBtn.addEventListener('click', resetVisualizerLayout);
    if (vizCloseBtn) vizCloseBtn.addEventListener('click', closeVisualizer);

    if (vizConnections) {
      vizConnections.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('button[data-connection-index]');
        if (removeBtn) {
          const index = Number(removeBtn.dataset.connectionIndex);
          removeVizConnection(selectedVizProject(), index);
          renderVisualizer();
          return;
        }
        const row = e.target.closest('.viz-connection-row-main[data-connection-index]');
        if (row) {
          openLegendPopover(selectedVizProject(), Number(row.dataset.connectionIndex), { x: e.clientX, y: e.clientY });
        }
      });
    }

    const vizLegendList = document.getElementById('vizLegendList');
    if (vizLegendList) {
      vizLegendList.addEventListener('change', (e) => {
        const colorInput = e.target.closest('.viz-legend-row-color');
        const nameInput = e.target.closest('.viz-legend-row-name');
        const input = colorInput || nameInput;
        if (!input) return;
        const patch = colorInput ? { color: input.value } : { name: input.value };
        updateLegendEntry(selectedVizProject(), input.dataset.legendId, patch);
        renderVisualizer();
      });
      vizLegendList.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-remove-legend]');
        if (!btn) return;
        if (!confirm('Delete this wire category? Wires using it will fall back to the default color.')) return;
        removeLegendEntry(selectedVizProject(), btn.dataset.removeLegend);
      });
    }

    const vizLegendAddForm = document.getElementById('vizLegendAddForm');
    if (vizLegendAddForm) {
      vizLegendAddForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const nameInput = document.getElementById('vizLegendAddName');
        const colorInput = document.getElementById('vizLegendAddColor');
        if (!nameInput || !nameInput.value.trim()) return;
        addLegendEntry(selectedVizProject(), nameInput.value, colorInput ? colorInput.value : undefined);
        nameInput.value = '';
        renderVisualizer();
      });
    }

    // Miro-style drag-to-connect: press down on a dot, drag to another dot to link them.
    // Delegated on #vizNodes so it survives full re-renders without re-attaching per dot.
    function finishWireDrag(ev, cancelled) {
      const source = vizWireDragSource;
      vizWireDragSource = null;
      vizGhostPointer = null;
      if (vizStage) vizStage.classList.remove('wiring');
      document.querySelectorAll('.wiring-source-dot').forEach((el) => el.classList.remove('wiring-source-dot'));
      const ghost = vizWires && vizWires.querySelector('.viz-ghost-wire');
      if (ghost) ghost.remove();
      if (cancelled || !source) return;

      const dropEl = document.elementFromPoint(ev.clientX, ev.clientY);
      const targetDot = dropEl && dropEl.closest('[data-connector-dot]');
      const targetNodeEl = targetDot && targetDot.closest('.viz-node');
      if (!targetDot || !targetNodeEl) return;

      const targetPart = Number(targetDot.dataset.segmentIndex);
      const targetSide = targetDot.dataset.dotSide;
      const targetId = targetNodeEl.dataset.itemId;
      const index = addVizConnection(vizProject, source.id, targetId, source.part, targetPart, source.side, targetSide);
      if (index < 0) return;
      renderVisualizer();
      // renderVisualizer() re-sanitizes connections, which can shift indices if an unrelated
      // stale entry was pruned in the same pass — re-find the just-created connection by its
      // actual fields rather than trusting the pre-render index.
      const freshIndex = getVizConnections(vizProject).findIndex((c) =>
        c.from === source.id && c.to === targetId && c.fromPart === source.part && c.toPart === targetPart && c.fromSide === source.side && c.toSide === targetSide
      );
      if (freshIndex >= 0) openLegendPopover(vizProject, freshIndex, { x: ev.clientX, y: ev.clientY });
    }

    if (vizNodes) {
      vizNodes.addEventListener('pointerdown', (ev) => {
        const dot = ev.target.closest('button[data-connector-dot]');
        if (!dot) return;
        const nodeEl = dot.closest('.viz-node');
        if (!nodeEl) return;
        ev.preventDefault();
        vizWireDragSource = {
          id: nodeEl.dataset.itemId,
          part: Number(dot.dataset.segmentIndex),
          side: dot.dataset.dotSide
        };
        try { dot.setPointerCapture(ev.pointerId); } catch (e) {}
        if (vizStage) vizStage.classList.add('wiring');
        dot.classList.add('wiring-source-dot');
      });
      vizNodes.addEventListener('pointerup', (ev) => {
        if (!vizWireDragSource) return;
        finishWireDrag(ev, false);
      });
      vizNodes.addEventListener('pointercancel', (ev) => {
        if (!vizWireDragSource) return;
        finishWireDrag(ev, true);
      });
    }

    if (vizWires) {
      vizWires.addEventListener('click', (e) => {
        const hit = e.target.closest('.viz-wire-hit');
        if (!hit) return;
        openLegendPopover(vizProject, Number(hit.dataset.connectionIndex), { x: e.clientX, y: e.clientY });
      });
    }

    if (vizStage) {
      // wheel to zoom when ctrl/meta pressed, anchored on the cursor position
      vizStage.addEventListener('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const anchor = { x: e.clientX, y: e.clientY };
        if (e.deltaY < 0) zoomIn(anchor); else zoomOut(anchor);
      }, { passive: false });
      // live ghost wire while a wire-drag is in progress
      vizStage.addEventListener('pointermove', (e) => {
        if (!vizWireDragSource) return;
        vizGhostPointer = { x: e.clientX, y: e.clientY };
        scheduleGhostWire();
      });
      // on scroll (pan) do a lightweight rAF-throttled wire redraw using cached nodes/connections
      vizStage.addEventListener('scroll', () => {
        if (_scrollRaf) return;
        _scrollRaf = requestAnimationFrame(() => {
          try { updateWireLayer(vizProject, vizLastNodes || [], vizLastConnections || []); } catch (e) {}
          _scrollRaf = null;
        });
      }, { passive: true });
      // page/window scroll can move the stage in the viewport; throttle updates via rAF as well
      window.addEventListener('scroll', () => {
        if (_scrollRaf) return;
        _scrollRaf = requestAnimationFrame(() => {
          try { updateWireLayer(vizProject, vizLastNodes || [], vizLastConnections || []); } catch (e) {}
          _scrollRaf = null;
        });
      }, { passive: true });
    }

  // wire up header zoom buttons if present
  const zoomInBtn = document.getElementById('vizZoomIn');
  const zoomOutBtn = document.getElementById('vizZoomOut');
  const zoomResetBtn = document.getElementById('vizZoomReset');
  const zoomFitBtn = document.getElementById('vizZoomFit');
  if (zoomInBtn) zoomInBtn.addEventListener('click', () => zoomIn());
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => zoomOut());
  if (zoomResetBtn) zoomResetBtn.addEventListener('click', zoomReset);
  if (zoomFitBtn) zoomFitBtn.addEventListener('click', fitToView);

    window.addEventListener('resize', () => {
      if (vizForm && !vizForm.classList.contains('hidden')) renderVisualizer();
    });

    return {
      openVisualizer,
      closeVisualizer,
      resetVisualizerLayout,
      clearVisualizerConnections,
      populateVisualizerProjects,
      renderVisualizer,
      selectedVizProject,
      setProject(project) {
        if (vizProjectSelect) vizProjectSelect.value = project;
        vizProject = project;
        ensureVizDataLoaded(project).then(renderVisualizer);
      }
    };
  }

  return { create };
})();

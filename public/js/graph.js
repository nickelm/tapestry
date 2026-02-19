// graph.js — D3 force-directed graph with rectilinear edges

// Custom gravity force: pulls nodes toward center with strength proportional to distance.
// Replaces d3.forceCenter which only shifts center-of-mass.
function forceGravity(center, strength) {
  let nodes;
  function force(alpha) {
    for (const node of nodes) {
      if (node.fx != null || node.fy != null) continue;
      const dx = center.x - node.x;
      const dy = center.y - node.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0) {
        const k = strength * alpha * dist * 0.01;
        node.vx += dx / dist * k;
        node.vy += dy / dist * k;
      }
    }
  }
  force.initialize = (n) => { nodes = n; };
  return force;
}

// Custom rectangular repulsion force: pushes nodes out of a paper-shaped rectangle.
function forcePaperRepel(paperRect, strength) {
  let nodes;
  function force(alpha) {
    if (!paperRect.active) return;
    const halfW = paperRect.width / 2 + 20;
    const halfH = paperRect.height / 2 + 20;
    const left = paperRect.cx - halfW;
    const right = paperRect.cx + halfW;
    const top = paperRect.cy - halfH;
    const bottom = paperRect.cy + halfH;
    for (const node of nodes) {
      if (node.fx != null && node.fy != null) continue;
      if (node.x > left && node.x < right && node.y > top && node.y < bottom) {
        const dLeft = node.x - left;
        const dRight = right - node.x;
        const dTop = node.y - top;
        const dBottom = bottom - node.y;
        const minD = Math.min(dLeft, dRight, dTop, dBottom);
        const k = strength * alpha;
        if (minD === dLeft) node.vx -= k * (halfW - dLeft);
        else if (minD === dRight) node.vx += k * (halfW - dRight);
        else if (minD === dTop) node.vy -= k * (halfH - dTop);
        else node.vy += k * (halfH - dBottom);
      }
    }
  }
  force.initialize = (n) => { nodes = n; };
  return force;
}

class TapestryGraph {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.nodes = [];
    this.edges = [];
    this.nodeMap = new Map();
    this.edgeMap = new Map();
    this.selectedNodeId = null;
    this.hoveredNodeId = null;
    this.userHovers = new Map(); // userId -> nodeId
    this._clickTimer = null;

    this.onNodeContext = null; // callback(nodeId, x, y)
    this.onNodeClick = null;
    this.onNodeDoubleClick = null;
    this.onNodeDragEnd = null;
    this.onNodeHover = null;
    this.onNodeUnhover = null;
    this.onNodeUpvote = null;
    this.onEdgeContext = null; // callback(edgeId, x, y)
    this.onCanvasClick = null;
    this.onPaperDoubleClick = null; // callback(paperUrl)
    this._mergeMode = false;
    this._searchMatchIds = null; // Set of matching node IDs during search, or null

    // Paper overlay state (F17)
    this._paperOverlay = null;
    this._paperCanvas = null;
    this._pdfDoc = null;
    this._paperUrl = null;
    this._paperCurrentPage = 1;
    this._paperTotalPages = 0;
    this._paperPageCache = {};
    this.PAPER_WIDTH = 420;
    this.PAPER_HEIGHT = 540;
    this.PAPER_TITLE_HEIGHT = 32;
    this.PAPER_NAV_HEIGHT = 36;
    this._paperX = -420 / 2;
    this._paperY = -(32 + 540 + 36) / 2;
    this._paperCollisionRect = { cx: 0, cy: 0, width: 420, height: 32 + 540 + 36, active: false };

    this.NODE_WIDTH = 180;
    this.NODE_HEIGHT = 52;
    this.NODE_PADDING = 12;

    this._initSVG();
    this._initSimulation();
    this._initZoom();
    this._initTooltip();

    window.addEventListener('resize', () => this._resize());
    this._resize();
  }

  _initTooltip() {
    this._tooltip = document.createElement('div');
    this._tooltip.className = 'graph-tooltip';
    this.container.appendChild(this._tooltip);
  }

  _showTooltip(nodeId, event) {
    const node = this.nodeMap.get(nodeId);
    if (!node || !node.description) return;
    const desc = this._stripTitleFromDesc(node.title, node.description);
    this._tooltip.textContent = desc;
    this._tooltip.classList.add('visible');
    this._positionTooltip(event);
  }

  _positionTooltip(event) {
    const rect = this.container.getBoundingClientRect();
    let x = event.clientX - rect.left + 12;
    let y = event.clientY - rect.top + 12;
    // Clamp so it doesn't overflow
    const tw = this._tooltip.offsetWidth;
    const th = this._tooltip.offsetHeight;
    if (x + tw > rect.width - 8) x = event.clientX - rect.left - tw - 8;
    if (y + th > rect.height - 8) y = event.clientY - rect.top - th - 8;
    this._tooltip.style.left = x + 'px';
    this._tooltip.style.top = y + 'px';
  }

  _hideTooltip() {
    this._tooltip.classList.remove('visible');
  }

  _initSVG() {
    this.svg = d3.select(this.container).select('svg')
      .attr('width', '100%')
      .attr('height', '100%');

    // Defs for filters and arrowheads
    const defs = this.svg.append('defs');

    // Drop shadow filter
    const filter = defs.append('filter')
      .attr('id', 'dropShadow')
      .attr('x', '-20%').attr('y', '-20%')
      .attr('width', '140%').attr('height', '140%');
    filter.append('feDropShadow')
      .attr('dx', '0').attr('dy', '1')
      .attr('stdDeviation', '3')
      .attr('flood-color', 'rgba(0,0,0,0.18)');

    // Arrowhead (for directed edges)
    defs.append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '0 0 10 6')
      .attr('refX', '10').attr('refY', '3')
      .attr('markerWidth', '8').attr('markerHeight', '6')
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,0 L10,3 L0,6 Z')
      .attr('class', 'edge-arrowhead');

    // Symmetric dot (for undirected edges)
    defs.append('marker')
      .attr('id', 'symmetric-dot')
      .attr('viewBox', '0 0 6 6')
      .attr('refX', '3').attr('refY', '3')
      .attr('markerWidth', '5').attr('markerHeight', '5')
      .attr('orient', 'auto')
      .append('circle')
      .attr('cx', '3').attr('cy', '3').attr('r', '2.5')
      .attr('class', 'edge-symmetric-dot');

    // Main group for zoom/pan
    this.g = this.svg.append('g').attr('class', 'graph-root');
    this.edgeGroup = this.g.append('g').attr('class', 'edges');
    this.edgeLabelGroup = this.g.append('g').attr('class', 'edge-labels');
    this.nodeGroup = this.g.append('g').attr('class', 'nodes');

    // Rubberband line for connection mode
    this._rubberband = this.g.append('line')
      .attr('class', 'rubberband-line')
      .style('display', 'none');
    this._rubberbandSourceId = null;

    this.svg.on('mousemove.rubberband', (event) => {
      if (!this._rubberbandSourceId) return;
      const source = this.nodeMap.get(this._rubberbandSourceId);
      if (!source) return;
      const [mx, my] = d3.pointer(event, this.g.node());
      this._rubberband
        .attr('x1', source.x).attr('y1', source.y)
        .attr('x2', mx).attr('y2', my);
    });
  }

  _initSimulation() {
    this.simulation = d3.forceSimulation()
      .force('link', d3.forceLink().id(d => d.id)
        .distance(d => {
          const s = typeof d.source === 'object' ? d.source : this.nodeMap.get(d.source);
          const t = typeof d.target === 'object' ? d.target : this.nodeMap.get(d.target);
          return (s && s.hidden) || (t && t.hidden) ? 350 : 60;
        })
        .strength(d => {
          const s = typeof d.source === 'object' ? d.source : this.nodeMap.get(d.source);
          const t = typeof d.target === 'object' ? d.target : this.nodeMap.get(d.target);
          return (s && s.hidden) || (t && t.hidden) ? 0.8 : 1.5;
        })
        .iterations(2))
      .force('charge', d3.forceManyBody()
        .strength(-150)
        .distanceMax(300))
      .force('collision', d3.forceCollide()
        .radius(d => Math.max(this.NODE_WIDTH, this.NODE_HEIGHT) / 2 + 8)
        .strength(0.7)
        .iterations(2))
      .force('gravity', forceGravity({ x: 0, y: 0 }, 0.5))
      .force('paperRepel', forcePaperRepel(this._paperCollisionRect, 0.8))
      .on('tick', () => this._tick());
  }

  _initZoom() {
    this.zoom = d3.zoom()
      .scaleExtent([0.2, 3])
      .on('zoom', (event) => {
        this.g.attr('transform', event.transform);
        this.currentTransform = event.transform;
        this._updatePaperTransform();
      });

    this.svg.call(this.zoom);
    this.currentTransform = d3.zoomIdentity;

    // Click on empty canvas deselects
    this.svg.on('click', () => {
      if (this.selectedNodeId !== null) {
        this.setSelected(null);
        if (this.onCanvasClick) this.onCanvasClick();
      }
    });
  }

  _updatePaperTransform() {
    if (!this._paperOverlay) return;
    const t = this.currentTransform;
    const screenX = t.x + this._paperX * t.k;
    const screenY = t.y + this._paperY * t.k;
    this._paperOverlay.style.transform = `translate(${screenX}px, ${screenY}px) scale(${t.k})`;
  }

  _resize() {
    const rect = this.container.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
  }

  // --- Rectilinear edge path ---
  _rectilinearPath(source, target) {
    // If one endpoint is hidden (standin behind paper), terminate at paper boundary
    if (source.hidden || target.hidden) {
      return this._paperEdgePath(source, target);
    }

    const sx = source.x;
    const sy = source.y;
    const tx = target.x;
    const ty = target.y;

    const dx = tx - sx;
    const dy = ty - sy;

    // Determine exit/entry points on node boundaries
    let x1, y1, x2, y2;
    const hw = this.NODE_WIDTH / 2 + 4;
    const hh = this.NODE_HEIGHT / 2 + 4;

    if (Math.abs(dx) > Math.abs(dy)) {
      // Horizontal dominant
      x1 = sx + (dx > 0 ? hw : -hw);
      y1 = sy;
      x2 = tx + (dx > 0 ? -hw : hw);
      y2 = ty;
    } else {
      // Vertical dominant
      x1 = sx;
      y1 = sy + (dy > 0 ? hh : -hh);
      x2 = tx;
      y2 = ty + (dy > 0 ? -hh : hh);
    }

    // Rectilinear routing: go horizontal from source, then vertical to target
    const midX = (x1 + x2) / 2;

    if (Math.abs(dx) > Math.abs(dy)) {
      return `M${x1},${y1} L${midX},${y1} L${midX},${y2} L${x2},${y2}`;
    } else {
      const midY = (y1 + y2) / 2;
      return `M${x1},${y1} L${x1},${midY} L${x2},${midY} L${x2},${y2}`;
    }
  }

  // Route edge from a visible concept to the paper boundary (for hidden standin edges)
  _paperEdgePath(source, target) {
    const hidden = source.hidden ? source : target;
    const visible = source.hidden ? target : source;

    // Paper boundary dimensions (half-width/height + margin)
    const phw = this.PAPER_WIDTH / 2 + 10;
    const phh = this._paperCollisionRect.height / 2 + 10;

    // Direction from hidden center to visible node
    const dx = visible.x - hidden.x;
    const dy = visible.y - hidden.y;
    if (dx === 0 && dy === 0) return '';

    // Find exit point on paper boundary rectangle
    let bx, by;
    if (Math.abs(dx / phw) > Math.abs(dy / phh)) {
      // Exits left or right edge
      bx = hidden.x + (dx > 0 ? phw : -phw);
      by = hidden.y + dy * (phw / Math.abs(dx));
      by = Math.max(hidden.y - phh, Math.min(hidden.y + phh, by));
    } else {
      // Exits top or bottom edge
      by = hidden.y + (dy > 0 ? phh : -phh);
      bx = hidden.x + dx * (phh / Math.abs(dy));
      bx = Math.max(hidden.x - phw, Math.min(hidden.x + phw, bx));
    }

    // Visible node boundary point
    const nhw = this.NODE_WIDTH / 2 + 4;
    const nhh = this.NODE_HEIGHT / 2 + 4;
    const edx = visible.x - bx;
    const edy = visible.y - by;
    let vx, vy;
    if (Math.abs(edx) > Math.abs(edy)) {
      vx = visible.x + (edx > 0 ? -nhw : nhw);
      vy = visible.y;
    } else {
      vx = visible.x;
      vy = visible.y + (edy > 0 ? -nhh : nhh);
    }

    // Rectilinear route from paper boundary to concept boundary
    if (Math.abs(edx) > Math.abs(edy)) {
      const midX = (bx + vx) / 2;
      return `M${bx},${by} L${midX},${by} L${midX},${vy} L${vx},${vy}`;
    } else {
      const midY = (by + vy) / 2;
      return `M${bx},${by} L${bx},${midY} L${vx},${midY} L${vx},${vy}`;
    }
  }

  _tick() {
    // Bounding box clamp — keep unpinned nodes within ±1.5× viewport
    const bw = this.width * 1.5;
    const bh = this.height * 1.5;
    const pad = 50;
    for (const node of this.nodes) {
      if (node.fx != null) continue;
      node.x = Math.max(-bw + pad, Math.min(bw - pad, node.x));
      node.y = Math.max(-bh + pad, Math.min(bh - pad, node.y));
    }

    // Update node positions
    this.nodeGroup.selectAll('.node-group')
      .attr('transform', d => `translate(${d.x - this.NODE_WIDTH/2}, ${d.y - this.NODE_HEIGHT/2})`);

    // Update edge paths
    this.edgeGroup.selectAll('.edge-path')
      .attr('d', d => {
        const source = this.nodeMap.get(d.source_id || (d.source && d.source.id) || d.source);
        const target = this.nodeMap.get(d.target_id || (d.target && d.target.id) || d.target);
        if (!source || !target) return '';
        return this._rectilinearPath(source, target);
      });

    // Update edge labels
    this.edgeLabelGroup.selectAll('.edge-label-group')
      .attr('transform', d => {
        const source = this.nodeMap.get(d.source_id || (d.source && d.source.id) || d.source);
        const target = this.nodeMap.get(d.target_id || (d.target && d.target.id) || d.target);
        if (!source || !target) return '';
        // For hidden-endpoint edges, place label near the visible concept (not under PDF)
        if (source.hidden || target.hidden) {
          const visible = source.hidden ? target : source;
          const hidden = source.hidden ? source : target;
          const mx = visible.x + (hidden.x - visible.x) * 0.3;
          const my = visible.y + (hidden.y - visible.y) * 0.3;
          return `translate(${mx}, ${my})`;
        }
        const mx = (source.x + target.x) / 2;
        const my = (source.y + target.y) / 2;
        return `translate(${mx}, ${my})`;
      });
  }

  // --- Truncate text ---
  _truncate(text, maxLen) {
    if (!text) return '';
    return text.length > maxLen ? text.substring(0, maxLen - 1) + '…' : text;
  }

  // Strip title (or partial title words) from the start of a description.
  // e.g. title="Ludwig Wittgenstein", desc="Wittgenstein was an Austrian..." → "was an Austrian..."
  _stripTitleFromDesc(title, desc) {
    if (!desc || !title) return desc || '';
    const titleWords = title.toLowerCase().split(/\s+/);
    let d = desc.replace(/^\s+/, '');
    // Greedily strip leading words that appear in the title
    let stripped = true;
    while (stripped) {
      stripped = false;
      for (const word of titleWords) {
        if (word.length < 2) continue;
        const re = new RegExp(`^${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s,;:\\-]*`, 'i');
        if (re.test(d)) {
          d = d.replace(re, '');
          stripped = true;
        }
      }
    }
    // If we stripped everything or nearly everything, fall back to original
    if (d.length < 5) return desc;
    // Lowercase the first char since we may have removed the sentence subject
    return d.charAt(0).toLowerCase() + d.slice(1);
  }

  // --- Highlight / Dim helpers (F11) ---

  _getEdgeEndpoints(edge) {
    const sourceId = edge.source_id || (edge.source && edge.source.id) || edge.source;
    const targetId = edge.target_id || (edge.target && edge.target.id) || edge.target;
    return { sourceId, targetId };
  }

  _getNeighbors(nodeId) {
    const neighborIds = new Set();
    const edgeIds = new Set();
    for (const edge of this.edges) {
      const { sourceId, targetId } = this._getEdgeEndpoints(edge);
      if (sourceId === nodeId) {
        neighborIds.add(targetId);
        edgeIds.add(edge.id);
      } else if (targetId === nodeId) {
        neighborIds.add(sourceId);
        edgeIds.add(edge.id);
      }
    }
    return { neighborIds, edgeIds };
  }

  _highlightNode(nodeId) {
    const { neighborIds, edgeIds } = this._getNeighbors(nodeId);
    const keepNodes = new Set([nodeId, ...neighborIds]);

    if (this._searchMatchIds) {
      // F12 active: non-matching nodes stay dimmed, hover applies within matched set
      this.nodeGroup.selectAll('.node-group')
        .classed('dimmed', d => !this._searchMatchIds.has(d.id) || !keepNodes.has(d.id));
    } else {
      this.nodeGroup.selectAll('.node-group')
        .classed('dimmed', d => !keepNodes.has(d.id));
    }
    this.edgeGroup.selectAll('.edge-path')
      .classed('dimmed', d => !edgeIds.has(d.id));
    this.edgeLabelGroup.selectAll('.edge-label-group')
      .classed('dimmed', d => !edgeIds.has(d.id));
  }

  _highlightEdge(edgeId) {
    const edge = this.edgeMap.get(edgeId);
    if (!edge) return;

    const { sourceId, targetId } = this._getEdgeEndpoints(edge);
    const keepNodes = new Set([sourceId, targetId]);

    // Z-reorder (permanent): raise edge path and label group
    this.edgeGroup.selectAll('.edge-path')
      .filter(d => d.id === edgeId).raise();
    this.edgeLabelGroup.selectAll('.edge-label-group')
      .filter(d => d.id === edgeId).raise();

    // Highlight the hovered edge
    this.edgeGroup.selectAll('.edge-path')
      .filter(d => d.id === edgeId).classed('edge-highlighted', true);
    this.edgeLabelGroup.selectAll('.edge-label-group')
      .filter(d => d.id === edgeId).classed('edge-highlighted', true);

    // Dim everything else
    if (this._searchMatchIds) {
      // F12 active: non-matching nodes stay dimmed
      this.nodeGroup.selectAll('.node-group')
        .classed('dimmed', d => !this._searchMatchIds.has(d.id) || !keepNodes.has(d.id));
    } else {
      this.nodeGroup.selectAll('.node-group')
        .classed('dimmed', d => !keepNodes.has(d.id));
    }
    this.edgeGroup.selectAll('.edge-path')
      .classed('dimmed', d => d.id !== edgeId);
    this.edgeLabelGroup.selectAll('.edge-label-group')
      .classed('dimmed', d => d.id !== edgeId);
  }

  _clearHighlight() {
    if (this._searchMatchIds) {
      // Restore search dimming instead of clearing everything
      this.applySearchFilter(this._searchMatchIds);
    } else {
      this.nodeGroup.selectAll('.node-group').classed('dimmed', false);
      this.edgeGroup.selectAll('.edge-path').classed('dimmed', false);
      this.edgeLabelGroup.selectAll('.edge-label-group').classed('dimmed', false);
    }
    // Always clear edge-highlighted
    this.edgeGroup.selectAll('.edge-path').classed('edge-highlighted', false);
    this.edgeLabelGroup.selectAll('.edge-label-group').classed('edge-highlighted', false);
  }

  // --- Search filter (F12) ---

  applySearchFilter(matchingNodeIds) {
    this._searchMatchIds = matchingNodeIds;
    if (!matchingNodeIds) {
      // Clear all search dimming
      this.nodeGroup.selectAll('.node-group').classed('dimmed', false);
      this.edgeGroup.selectAll('.edge-path').classed('dimmed', false).classed('edge-highlighted', false);
      this.edgeLabelGroup.selectAll('.edge-label-group').classed('dimmed', false).classed('edge-highlighted', false);
      return;
    }
    // Dim non-matching nodes
    this.nodeGroup.selectAll('.node-group')
      .classed('dimmed', d => !matchingNodeIds.has(d.id));
    // Edges: visible only if both endpoints match
    this.edgeGroup.selectAll('.edge-path')
      .classed('dimmed', d => {
        const { sourceId, targetId } = this._getEdgeEndpoints(d);
        return !matchingNodeIds.has(sourceId) || !matchingNodeIds.has(targetId);
      });
    this.edgeLabelGroup.selectAll('.edge-label-group')
      .classed('dimmed', d => {
        const { sourceId, targetId } = this._getEdgeEndpoints(d);
        return !matchingNodeIds.has(sourceId) || !matchingNodeIds.has(targetId);
      });
  }

  // --- Render ---
  render(restartSimulation = true) {
    const self = this;

    // --- EDGES ---
    const edgeSelection = this.edgeGroup.selectAll('.edge-path')
      .data(this.edges, d => d.id);

    edgeSelection.exit().remove();

    const edgeEnter = edgeSelection.enter()
      .append('path')
      .attr('class', 'edge-path');

    edgeEnter.on('contextmenu', function(event, d) {
      event.preventDefault();
      event.stopPropagation();
      if (self.onEdgeContext) self.onEdgeContext(d.id, event.clientX, event.clientY);
    });

    edgeEnter.on('mouseenter', function(event, d) {
      d3.select(this).classed('edge-hover', true);
      self.edgeLabelGroup.selectAll('.edge-label-group')
        .filter(e => e.id === d.id)
        .classed('edge-label-hover', true);
      if (!self._rubberbandSourceId && !self._mergeMode) self._highlightEdge(d.id);
    }).on('mouseleave', function(event, d) {
      d3.select(this).classed('edge-hover', false);
      self.edgeLabelGroup.selectAll('.edge-label-group')
        .filter(e => e.id === d.id)
        .classed('edge-label-hover', false);
      if (!self._rubberbandSourceId && !self._mergeMode) self._clearHighlight();
    });

    const mergedEdges = edgeEnter.merge(edgeSelection);
    mergedEdges
      .attr('marker-end', d => d.directed ? 'url(#arrowhead)' : 'url(#symmetric-dot)')
      .attr('marker-start', d => d.directed ? null : 'url(#symmetric-dot)');

    // Edge labels
    const edgeLabelSel = this.edgeLabelGroup.selectAll('.edge-label-group')
      .data(this.edges, d => d.id);

    edgeLabelSel.exit().remove();

    const edgeLabelEnter = edgeLabelSel.enter()
      .append('g')
      .attr('class', 'edge-label-group');

    edgeLabelEnter.on('contextmenu', function(event, d) {
      event.preventDefault();
      event.stopPropagation();
      if (self.onEdgeContext) self.onEdgeContext(d.id, event.clientX, event.clientY);
    });

    edgeLabelEnter.on('mouseenter', function(event, d) {
      d3.select(this).classed('edge-label-hover', true);
      self.edgeGroup.selectAll('.edge-path')
        .filter(e => e.id === d.id)
        .classed('edge-hover', true);
      if (!self._rubberbandSourceId && !self._mergeMode) self._highlightEdge(d.id);
    }).on('mouseleave', function(event, d) {
      d3.select(this).classed('edge-label-hover', false);
      self.edgeGroup.selectAll('.edge-path')
        .filter(e => e.id === d.id)
        .classed('edge-hover', false);
      if (!self._rubberbandSourceId && !self._mergeMode) self._clearHighlight();
    });

    edgeLabelEnter.append('rect')
      .attr('fill', '#fafafa')
      .attr('stroke', '#b0bec5')
      .attr('stroke-width', 1)
      .attr('rx', 3).attr('ry', 3)
      .attr('opacity', 0.95);

    edgeLabelEnter.append('text')
      .attr('class', 'edge-label')
      .attr('text-anchor', 'middle')
      .attr('dy', '0.35em');

    const mergedEdgeLabels = edgeLabelEnter.merge(edgeLabelSel);
    mergedEdgeLabels.select('text').text(d => (d.label || '').replace(/_/g, ' '));
    // Size the background rect to fit the label
    mergedEdgeLabels.each(function(d) {
      const text = d3.select(this).select('text');
      const bbox = text.node().getBBox();
      d3.select(this).select('rect')
        .attr('x', bbox.x - 4)
        .attr('y', bbox.y - 2)
        .attr('width', bbox.width + 8)
        .attr('height', bbox.height + 4);
    });

    // --- NODES (hidden nodes stay in simulation but get no SVG elements) ---
    const visibleNodes = this.nodes.filter(n => !n.hidden);
    const nodeSelection = this.nodeGroup.selectAll('.node-group')
      .data(visibleNodes, d => d.id);

    nodeSelection.exit().remove();

    const nodeEnter = nodeSelection.enter()
      .append('g')
      .attr('class', 'node-group')
      .attr('transform', d => `translate(${d.x - this.NODE_WIDTH/2}, ${d.y - this.NODE_HEIGHT/2})`);

    // Stack cards for merged nodes
    nodeEnter.each(function(d) {
      if (d.merged_count > 0) {
        const stackCount = Math.min(d.merged_count, 3);
        for (let i = stackCount; i > 0; i--) {
          d3.select(this).append('rect')
            .attr('class', 'node-stack-card')
            .attr('x', i * 3)
            .attr('y', -i * 3)
            .attr('width', self.NODE_WIDTH)
            .attr('height', self.NODE_HEIGHT);
        }
      }
    });

    // Main card
    nodeEnter.append('rect')
      .attr('class', 'node-card')
      .attr('width', this.NODE_WIDTH)
      .attr('height', this.NODE_HEIGHT);

    // Title
    nodeEnter.append('text')
      .attr('class', 'node-title')
      .attr('x', this.NODE_PADDING)
      .attr('y', 20);

    // Description
    nodeEnter.append('text')
      .attr('class', 'node-description')
      .attr('x', this.NODE_PADDING)
      .attr('y', 38);

    // Upvote badge (top-left circle)
    nodeEnter.append('circle')
      .attr('class', 'node-upvote-bg')
      .attr('cx', -4)
      .attr('cy', -4)
      .attr('r', 0)
      .attr('fill', '#2563eb')
      .attr('opacity', 0);

    nodeEnter.append('text')
      .attr('class', 'node-upvote-badge')
      .attr('x', -4)
      .attr('y', -1)
      .attr('text-anchor', 'middle')
      .attr('fill', 'white');

    // Upvote button (top-right corner)
    const upvoteBtn = nodeEnter.append('g')
      .attr('class', 'node-upvote-btn')
      .attr('transform', `translate(${this.NODE_WIDTH - 16}, 8)`)
      .style('cursor', 'pointer');

    upvoteBtn.append('circle')
      .attr('r', 10)
      .attr('fill', '#f1f5f9')
      .attr('stroke', '#e2e8f0')
      .attr('stroke-width', 1);

    upvoteBtn.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '0.35em')
      .attr('fill', '#64748b')
      .attr('font-size', '13px')
      .attr('font-weight', '600')
      .attr('pointer-events', 'none')
      .text('+');

    upvoteBtn.on('click', function(event, d) {
      event.stopPropagation();
      if (self.onNodeUpvote) self.onNodeUpvote(d.id);
    });

    // Contributor dots (bottom-right)
    nodeEnter.append('g')
      .attr('class', 'node-contributors')
      .attr('transform', `translate(${this.NODE_WIDTH - 8}, ${this.NODE_HEIGHT + 6})`);

    // Drag
    nodeEnter.call(d3.drag()
      .on('start', (event, d) => {
        if (!event.active) self.simulation.alphaTarget(0.1).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) self.simulation.alphaTarget(0);
        // Keep pinned
        d.pinned = true;
        if (self.onNodeDragEnd) self.onNodeDragEnd(d.id, d.x, d.y, true);
      })
    );

    // Click (delayed to allow double-click detection)
    nodeEnter.on('click', function(event, d) {
      event.stopPropagation();
      if (self._clickTimer) {
        clearTimeout(self._clickTimer);
        self._clickTimer = null;
        return;
      }
      self._clickTimer = setTimeout(() => {
        self._clickTimer = null;
        if (self.onNodeClick) self.onNodeClick(d.id, event);
      }, 250);
    });

    // Double-click
    nodeEnter.on('dblclick', function(event, d) {
      event.stopPropagation();
      event.preventDefault();
      if (self._clickTimer) {
        clearTimeout(self._clickTimer);
        self._clickTimer = null;
      }
      if (self.onNodeDoubleClick) self.onNodeDoubleClick(d.id);
    });

    // Context menu
    nodeEnter.on('contextmenu', function(event, d) {
      event.preventDefault();
      event.stopPropagation();
      if (self.onNodeContext) self.onNodeContext(d.id, event.clientX, event.clientY);
    });

    // Hover
    nodeEnter.on('mouseenter', function(event, d) {
      self._showTooltip(d.id, event);
      if (!self._rubberbandSourceId && !self._mergeMode) self._highlightNode(d.id);
      if (self.onNodeHover) self.onNodeHover(d.id);
    }).on('mousemove.tooltip', function(event, d) {
      if (self._tooltip.classList.contains('visible')) self._positionTooltip(event);
    }).on('mouseleave', function(event, d) {
      self._hideTooltip();
      if (!self._rubberbandSourceId && !self._mergeMode) self._clearHighlight();
      if (self.onNodeUnhover) self.onNodeUnhover(d.id);
    });

    // Update existing + new
    const mergedNodes = nodeEnter.merge(nodeSelection);

    mergedNodes.select('.node-title')
      .text(d => this._truncate(d.title, 24));

    mergedNodes.select('.node-description')
      .text(d => this._truncate(this._stripTitleFromDesc(d.title, d.description), 30));

    mergedNodes.select('.node-card')
      .classed('selected', d => d.id === this.selectedNodeId);

    // Upvote badges
    mergedNodes.select('.node-upvote-bg')
      .attr('r', d => d.upvotes > 0 ? 10 : 0)
      .attr('opacity', d => d.upvotes > 0 ? 1 : 0);

    mergedNodes.select('.node-upvote-badge')
      .text(d => d.upvotes > 0 ? d.upvotes : '');

    // Update upvote button appearance based on user's upvote state
    mergedNodes.select('.node-upvote-btn text')
      .text(d => this.userUpvotes && this.userUpvotes.has(d.id) ? '\u2212' : '+');
    mergedNodes.select('.node-upvote-btn circle')
      .attr('fill', d => this.userUpvotes && this.userUpvotes.has(d.id) ? '#dbeafe' : '#f1f5f9')
      .attr('stroke', d => this.userUpvotes && this.userUpvotes.has(d.id) ? '#2563eb' : '#e2e8f0');

    // Contributor dots
    mergedNodes.each(function(d) {
      const g = d3.select(this).select('.node-contributors');
      const dots = g.selectAll('.node-contributor-dot')
        .data(d.contributors || []);

      dots.exit().remove();

      dots.enter()
        .append('circle')
        .attr('class', 'node-contributor-dot')
        .attr('r', 5)
        .merge(dots)
        .attr('cx', (c, i) => -i * 10)
        .attr('cy', 0)
        .attr('fill', c => c.color || '#94a3b8');
    });

    // Presence hover indicators
    mergedNodes.each(function(d) {
      const g = d3.select(this);
      // Remove old presence indicators
      g.selectAll('.presence-indicator').remove();

      // Check if any users are hovering this node
      const hoveringUsers = [];
      self.userHovers.forEach((nodeId, userId) => {
        if (nodeId === d.id) hoveringUsers.push({ userId, ...self.userHoverDetails?.get(userId) });
      });

      if (hoveringUsers.length > 0) {
        hoveringUsers.forEach((user, i) => {
          g.append('circle')
            .attr('class', 'presence-indicator')
            .attr('cx', self.NODE_WIDTH + 8)
            .attr('cy', 10 + i * 14)
            .attr('r', 5)
            .attr('fill', user.color || '#94a3b8')
            .attr('stroke', 'white')
            .attr('stroke-width', 1.5);
        });
      }
    });

    // Update simulation
    if (restartSimulation) {
      this.simulation.nodes(this.nodes);
      this.simulation.force('link').links(this.edges.map(e => ({
        source: e.source_id || e.source,
        target: e.target_id || e.target
      })));
      this.simulation.alpha(0.3).restart();
    }
  }

  // --- Public API ---

  addNode(node) {
    node.hidden = !!node.hidden;
    node.pinned = !!node.pinned;
    // Set initial position if not already set (skip for pinned nodes)
    if (node.x === 0 && node.y === 0 && !node.pinned) {
      node.x = (Math.random() - 0.5) * 600;
      node.y = (Math.random() - 0.5) * 400;
    }
    if (node.pinned) {
      node.fx = node.x;
      node.fy = node.y;
    }
    this.nodes.push(node);
    this.nodeMap.set(node.id, node);
    this.render();
  }

  removeNode(nodeId) {
    this.nodes = this.nodes.filter(n => n.id !== nodeId);
    this.nodeMap.delete(nodeId);
    this.edges = this.edges.filter(e => {
      const sid = e.source_id || (e.source && e.source.id) || e.source;
      const tid = e.target_id || (e.target && e.target.id) || e.target;
      return sid !== nodeId && tid !== nodeId;
    });
    this.render();
  }

  updateNode(nodeId, updates) {
    const node = this.nodeMap.get(nodeId);
    if (node) {
      Object.assign(node, updates);
      this.render(false);
    }
  }

  addEdge(edge) {
    this.edges.push(edge);
    this.edgeMap.set(edge.id, edge);
    this.render();
  }

  updateEdgeLabel(edgeId, label) {
    const edge = this.edgeMap.get(edgeId);
    if (edge) {
      edge.label = label;
      this.render(false);
    }
  }

  updateEdgeDirected(edgeId, directed) {
    const edge = this.edgeMap.get(edgeId);
    if (edge) {
      edge.directed = directed;
      this.render(false);
    }
  }

  flipEdgeDirection(edgeId, newSourceId, newTargetId) {
    const edge = this.edgeMap.get(edgeId);
    if (edge) {
      edge.source_id = newSourceId;
      edge.target_id = newTargetId;
      this.render(false);
      this._tick(); // Force visual update of edge paths
    }
  }

  removeEdge(edgeId) {
    this.edges = this.edges.filter(e => e.id !== edgeId);
    this.edgeMap.delete(edgeId);
    this.render();
  }

  moveNode(nodeId, x, y, pinned) {
    const node = this.nodeMap.get(nodeId);
    if (node) {
      node.x = x;
      node.y = y;
      node.fx = pinned ? x : null;
      node.fy = pinned ? y : null;
      node.pinned = pinned;
    }
  }

  setSelected(nodeId) {
    this.selectedNodeId = nodeId;
    this.render(false);
  }

  showRubberband(sourceNodeId) {
    this._rubberbandSourceId = sourceNodeId;
    const source = this.nodeMap.get(sourceNodeId);
    if (source) {
      this._rubberband
        .attr('x1', source.x).attr('y1', source.y)
        .attr('x2', source.x).attr('y2', source.y)
        .style('display', null);
    }
  }

  hideRubberband() {
    this._rubberbandSourceId = null;
    this._rubberband.style('display', 'none');
  }

  setUserHover(userId, nodeId, details) {
    if (!this.userHoverDetails) this.userHoverDetails = new Map();
    if (nodeId) {
      this.userHovers.set(userId, nodeId);
      this.userHoverDetails.set(userId, details);
    } else {
      this.userHovers.delete(userId);
      this.userHoverDetails.delete(userId);
    }
    this.render(false);
  }

  fitView() {
    if (this.nodes.length === 0 && !this._paperOverlay) return;

    let minX, maxX, minY, maxY;

    if (this.nodes.length > 0) {
      const xs = this.nodes.map(n => n.x);
      const ys = this.nodes.map(n => n.y);
      minX = Math.min(...xs) - this.NODE_WIDTH;
      maxX = Math.max(...xs) + this.NODE_WIDTH;
      minY = Math.min(...ys) - this.NODE_HEIGHT;
      maxY = Math.max(...ys) + this.NODE_HEIGHT;
    } else {
      minX = maxX = 0;
      minY = maxY = 0;
    }

    // Include paper in bounds
    if (this._paperOverlay) {
      const totalH = this.PAPER_TITLE_HEIGHT + this.PAPER_HEIGHT + this.PAPER_NAV_HEIGHT;
      const pLeft = this._paperX - 20;
      const pRight = this._paperX + this.PAPER_WIDTH + 20;
      const pTop = this._paperY - 20;
      const pBottom = this._paperY + totalH + 20;
      minX = Math.min(minX, pLeft);
      maxX = Math.max(maxX, pRight);
      minY = Math.min(minY, pTop);
      maxY = Math.max(maxY, pBottom);
    }

    const dx = maxX - minX;
    const dy = maxY - minY;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const scale = Math.min(this.width / dx, this.height / dy, 1.5) * 0.85;
    const translate = [this.width / 2 - cx * scale, this.height / 2 - cy * scale];

    this.svg.transition().duration(500)
      .call(this.zoom.transform, d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale));
  }

  focusNode(nodeId) {
    const node = this.nodeMap.get(nodeId);
    if (!node) return;

    const scale = 1.2;
    const tx = this.width / 2 - node.x * scale;
    const ty = this.height / 2 - node.y * scale;

    this.svg.transition().duration(600)
      .call(this.zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale))
      .on('end', () => {
        const card = this.nodeGroup.selectAll('.node-group')
          .filter(d => d.id === nodeId)
          .select('.node-card');
        card.classed('node-highlight-pulse', true);
        setTimeout(() => card.classed('node-highlight-pulse', false), 1500);
      });
  }

  fitNodes(nodeIds) {
    const nodes = nodeIds.map(id => this.nodeMap.get(id)).filter(Boolean);
    if (nodes.length === 0) return;
    if (nodes.length === 1) {
      this.focusNode(nodes[0].id);
      return;
    }
    const xs = nodes.map(n => n.x);
    const ys = nodes.map(n => n.y);
    const minX = Math.min(...xs) - this.NODE_WIDTH;
    const maxX = Math.max(...xs) + this.NODE_WIDTH;
    const minY = Math.min(...ys) - this.NODE_HEIGHT;
    const maxY = Math.max(...ys) + this.NODE_HEIGHT;
    const dx = maxX - minX;
    const dy = maxY - minY;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const scale = Math.min(this.width / dx, this.height / dy, 1.5) * 0.85;
    const translate = [this.width / 2 - cx * scale, this.height / 2 - cy * scale];
    this.svg.transition().duration(400)
      .call(this.zoom.transform, d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale));
  }

  autoLayout() {
    // Unpin all nodes and restart simulation
    this.nodes.forEach(n => {
      n.fx = null;
      n.fy = null;
      n.pinned = false;
    });
    this.simulation.alpha(1).restart();

    // Fit view after settling
    setTimeout(() => this.fitView(), 1500);
  }

  exportSVG({ roomName, includeMetadata = true } = {}) {
    if (this.nodes.length === 0) {
      return { success: false, reason: 'empty' };
    }

    // Deep clone the live SVG
    const clone = this.svg.node().cloneNode(true);

    // Strip interactive and transient elements
    ['.node-upvote-btn', '.presence-indicator', '.rubberband-line'].forEach(sel => {
      clone.querySelectorAll(sel).forEach(el => el.remove());
    });

    // Remove transient CSS state classes
    clone.querySelectorAll('.node-card.selected').forEach(el => el.classList.remove('selected'));
    clone.querySelectorAll('.node-card.node-highlight-pulse').forEach(el => el.classList.remove('node-highlight-pulse'));
    clone.querySelectorAll('.edge-path.edge-hover').forEach(el => el.classList.remove('edge-hover'));
    clone.querySelectorAll('.edge-label-group.edge-label-hover').forEach(el => el.classList.remove('edge-label-hover'));
    clone.querySelectorAll('.dimmed').forEach(el => el.classList.remove('dimmed'));
    clone.querySelectorAll('.edge-highlighted').forEach(el => el.classList.remove('edge-highlighted'));

    // Reset graph-root transform (viewBox handles framing)
    const graphRoot = clone.querySelector('.graph-root');
    if (graphRoot) graphRoot.removeAttribute('transform');

    // Compute tight bounding box from node data
    const padding = 60;
    const xs = this.nodes.map(n => n.x);
    const ys = this.nodes.map(n => n.y);
    let minX = Math.min(...xs) - this.NODE_WIDTH / 2 - padding;
    let minY = Math.min(...ys) - this.NODE_HEIGHT / 2 - padding - 14; // upvote badge overhead
    let maxX = Math.max(...xs) + this.NODE_WIDTH / 2 + padding;
    let maxY = Math.max(...ys) + this.NODE_HEIGHT / 2 + padding + 16; // contributor dots below
    let width = maxX - minX;
    let height = maxY - minY;

    // Resolve CSS custom properties for inline attribute application
    const rootStyles = getComputedStyle(document.documentElement);
    const cssVars = {};
    ['--bg', '--surface', '--border', '--border-light', '--text', '--text-secondary', '--text-muted', '--accent', '--accent-light'].forEach(v => {
      cssVars[v] = rootStyles.getPropertyValue(v).trim();
    });

    // Apply styles as inline presentation attributes for maximum compatibility
    // (Inkscape and other SVG editors have limited CSS class support)
    const inlineStyles = {
      '.node-card': { fill: cssVars['--surface'], stroke: cssVars['--border'], 'stroke-width': '1.5', rx: '6', ry: '6', filter: 'url(#dropShadow)' },
      '.node-title': { 'font-family': "'IBM Plex Sans', sans-serif", 'font-size': '13px', 'font-weight': '500', fill: cssVars['--text'] },
      '.node-description': { 'font-family': "'IBM Plex Sans', sans-serif", 'font-size': '11px', fill: cssVars['--text-secondary'] },
      '.node-upvote-badge': { 'font-family': "'IBM Plex Sans', sans-serif", 'font-size': '11px', 'font-weight': '600' },
      '.node-contributor-dot': { stroke: cssVars['--surface'], 'stroke-width': '1.5' },
      '.node-stack-card': { fill: '#f8fafc', stroke: cssVars['--border'], 'stroke-width': '1', rx: '6', ry: '6' },
      '.edge-path': { fill: 'none', stroke: cssVars['--border'], 'stroke-width': '1.8' },
      '.edge-label': { 'font-family': "'IBM Plex Sans', sans-serif", 'font-size': '10px', fill: cssVars['--text-secondary'] },
      '.edge-arrowhead': { fill: cssVars['--text-muted'] },
      '.edge-symmetric-dot': { fill: cssVars['--text-muted'] },
    };
    for (const [selector, attrs] of Object.entries(inlineStyles)) {
      clone.querySelectorAll(selector).forEach(el => {
        for (const [attr, value] of Object.entries(attrs)) {
          el.setAttribute(attr, value);
        }
      });
    }

    // Replace feDropShadow (SVG2) with SVG 1.1 filter primitives for Inkscape compatibility
    const oldFilter = clone.querySelector('#dropShadow');
    if (oldFilter) {
      oldFilter.innerHTML = '';
      const ns = 'http://www.w3.org/2000/svg';
      const blur = document.createElementNS(ns, 'feGaussianBlur');
      blur.setAttribute('in', 'SourceAlpha');
      blur.setAttribute('stdDeviation', '3');
      blur.setAttribute('result', 'blur');
      const offset = document.createElementNS(ns, 'feOffset');
      offset.setAttribute('in', 'blur');
      offset.setAttribute('dx', '0');
      offset.setAttribute('dy', '1');
      offset.setAttribute('result', 'offsetBlur');
      const flood = document.createElementNS(ns, 'feFlood');
      flood.setAttribute('flood-color', '#000000');
      flood.setAttribute('flood-opacity', '0.18');
      flood.setAttribute('result', 'color');
      const comp = document.createElementNS(ns, 'feComposite');
      comp.setAttribute('in', 'color');
      comp.setAttribute('in2', 'offsetBlur');
      comp.setAttribute('operator', 'in');
      comp.setAttribute('result', 'shadow');
      const merge = document.createElementNS(ns, 'feMerge');
      const mn1 = document.createElementNS(ns, 'feMergeNode');
      mn1.setAttribute('in', 'shadow');
      const mn2 = document.createElementNS(ns, 'feMergeNode');
      mn2.setAttribute('in', 'SourceGraphic');
      merge.appendChild(mn1);
      merge.appendChild(mn2);
      oldFilter.appendChild(blur);
      oldFilter.appendChild(offset);
      oldFilter.appendChild(flood);
      oldFilter.appendChild(comp);
      oldFilter.appendChild(merge);
    }

    // Optional metadata text
    if (includeMetadata) {
      const metaText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      metaText.setAttribute('x', minX + 10);
      metaText.setAttribute('y', minY + height - 8);
      metaText.setAttribute('font-family', "'IBM Plex Sans', sans-serif");
      metaText.setAttribute('font-size', '10');
      metaText.setAttribute('fill', cssVars['--text-muted']);
      const dateStr = new Date().toISOString().slice(0, 10);
      metaText.textContent = `${roomName || 'Tapestry'} — ${dateStr} — ${this.nodes.length} concepts, ${this.edges.length} connections`;
      graphRoot.appendChild(metaText);
    }

    // Set viewBox and dimensions
    clone.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
    clone.setAttribute('width', width);
    clone.setAttribute('height', height);
    clone.removeAttribute('style');

    // XML namespaces
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

    // Serialize and download
    const serializer = new XMLSerializer();
    let svgString = '<?xml version="1.0" encoding="UTF-8"?>\n' + serializer.serializeToString(clone);

    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = (roomName || 'tapestry-graph').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = `tapestry-${safeName}-${dateStr}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return { success: true };
  }

  // --- Paper overlay (F17) ---

  showPaper(pdfDoc, paperTitle, paperUrl) {
    this._pdfDoc = pdfDoc;
    this._paperUrl = paperUrl;
    this._paperTitle = paperTitle;
    this._paperTotalPages = pdfDoc.numPages;
    this._paperCurrentPage = 1;
    this._paperPageCache = {};

    // Create overlay DOM
    const overlay = document.createElement('div');
    overlay.className = 'paper-overlay';
    overlay.style.transformOrigin = '0 0';

    // Title bar
    const titleBar = document.createElement('div');
    titleBar.className = 'paper-title-bar';
    titleBar.textContent = paperTitle || 'Paper';
    titleBar.title = paperTitle || '';
    overlay.appendChild(titleBar);

    // Canvas wrap
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'paper-canvas-wrap';

    const canvas = document.createElement('canvas');
    canvas.width = this.PAPER_WIDTH * 2;  // 2x for retina
    canvas.height = this.PAPER_HEIGHT * 2;
    canvas.style.width = this.PAPER_WIDTH + 'px';
    canvas.style.height = this.PAPER_HEIGHT + 'px';
    canvasWrap.appendChild(canvas);
    this._paperCanvas = canvas;

    // Loading placeholder
    const loading = document.createElement('div');
    loading.className = 'paper-loading';
    canvasWrap.appendChild(loading);

    overlay.appendChild(canvasWrap);

    // Navigation bar
    const navBar = document.createElement('div');
    navBar.className = 'paper-nav-bar';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'paper-nav-btn paper-prev';
    prevBtn.innerHTML = '&#9664;';
    prevBtn.addEventListener('click', (e) => { e.stopPropagation(); this._navigatePaper(-1); });

    const pageIndicator = document.createElement('span');
    pageIndicator.className = 'paper-page-indicator';
    this._paperPageIndicator = pageIndicator;

    const nextBtn = document.createElement('button');
    nextBtn.className = 'paper-nav-btn paper-next';
    nextBtn.innerHTML = '&#9654;';
    nextBtn.addEventListener('click', (e) => { e.stopPropagation(); this._navigatePaper(1); });

    navBar.appendChild(prevBtn);
    navBar.appendChild(pageIndicator);
    navBar.appendChild(nextBtn);
    overlay.appendChild(navBar);

    // Double-click opens PDF in reader panel
    overlay.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (this.onPaperDoubleClick && this._paperUrl) {
        this.onPaperDoubleClick(this._paperUrl);
      }
    });

    // Prevent overlay clicks from propagating to SVG (which deselects nodes)
    overlay.addEventListener('click', (e) => e.stopPropagation());
    overlay.addEventListener('mousedown', (e) => e.stopPropagation());

    // Forward wheel events to D3 zoom so graph zooms even when hovering over paper
    overlay.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const factor = Math.pow(2, -e.deltaY * 0.002);
      const svgRect = this.svg.node().getBoundingClientRect();
      const point = [e.clientX - svgRect.left, e.clientY - svgRect.top];
      this.svg.call(this.zoom.scaleBy, factor, point);
    }, { passive: false });

    this._paperOverlay = overlay;
    this.container.appendChild(overlay);

    // Activate collision force
    this._paperCollisionRect.active = true;
    this._paperCollisionRect.cx = 0;
    this._paperCollisionRect.cy = 0;
    this._paperCollisionRect.width = this.PAPER_WIDTH;
    this._paperCollisionRect.height = this.PAPER_TITLE_HEIGHT + this.PAPER_HEIGHT + this.PAPER_NAV_HEIGHT;
    this.simulation.alpha(0.3).restart();

    // Render first page
    this._updatePageIndicator();
    this._updatePaperTransform();
    this._renderPaperPage(1);
    this._preRenderAdjacentPages();
  }

  async _renderPaperPage(pageNum) {
    if (!this._pdfDoc || pageNum < 1 || pageNum > this._paperTotalPages) return;

    // Use cache if available
    if (this._paperPageCache[pageNum]) {
      this._swapVisibleCanvas(this._paperPageCache[pageNum]);
      return;
    }

    const page = await this._pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(
      (this.PAPER_WIDTH * 2) / viewport.width,
      (this.PAPER_HEIGHT * 2) / viewport.height
    );
    const scaledViewport = page.getViewport({ scale });

    const offCanvas = document.createElement('canvas');
    offCanvas.width = this.PAPER_WIDTH * 2;
    offCanvas.height = this.PAPER_HEIGHT * 2;
    const ctx = offCanvas.getContext('2d');

    // Center the page within the canvas
    const offsetX = (this.PAPER_WIDTH * 2 - scaledViewport.width) / 2;
    const offsetY = (this.PAPER_HEIGHT * 2 - scaledViewport.height) / 2;
    ctx.translate(offsetX, offsetY);

    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;

    this._paperPageCache[pageNum] = offCanvas;

    // LRU: keep at most 7 cached pages
    const cachedPages = Object.keys(this._paperPageCache).map(Number);
    if (cachedPages.length > 7) {
      const toEvict = cachedPages
        .filter(p => Math.abs(p - this._paperCurrentPage) > 3)
        .sort((a, b) => Math.abs(b - this._paperCurrentPage) - Math.abs(a - this._paperCurrentPage));
      for (const p of toEvict) {
        if (Object.keys(this._paperPageCache).length <= 7) break;
        delete this._paperPageCache[p];
      }
    }

    if (pageNum === this._paperCurrentPage) {
      this._swapVisibleCanvas(offCanvas);
    }
  }

  _swapVisibleCanvas(offCanvas) {
    if (!this._paperCanvas) return;
    const ctx = this._paperCanvas.getContext('2d');
    ctx.clearRect(0, 0, this._paperCanvas.width, this._paperCanvas.height);
    ctx.drawImage(offCanvas, 0, 0);
    // Hide loading placeholder
    const loading = this._paperOverlay?.querySelector('.paper-loading');
    if (loading) loading.style.display = 'none';
  }

  _navigatePaper(direction) {
    const newPage = this._paperCurrentPage + direction;
    if (newPage < 1 || newPage > this._paperTotalPages) return;
    this._paperCurrentPage = newPage;
    this._renderPaperPage(newPage);
    this._updatePageIndicator();
    this._preRenderAdjacentPages();
  }

  _preRenderAdjacentPages() {
    const prev = this._paperCurrentPage - 1;
    const next = this._paperCurrentPage + 1;
    if (prev >= 1 && !this._paperPageCache[prev]) this._renderPaperPage(prev);
    if (next <= this._paperTotalPages && !this._paperPageCache[next]) this._renderPaperPage(next);
  }

  _updatePageIndicator() {
    if (!this._paperPageIndicator) return;
    this._paperPageIndicator.textContent = `${this._paperCurrentPage} / ${this._paperTotalPages}`;
    // Disable buttons at boundaries
    const prevBtn = this._paperOverlay?.querySelector('.paper-prev');
    const nextBtn = this._paperOverlay?.querySelector('.paper-next');
    if (prevBtn) prevBtn.disabled = this._paperCurrentPage <= 1;
    if (nextBtn) nextBtn.disabled = this._paperCurrentPage >= this._paperTotalPages;
  }

  removePaper() {
    if (this._paperOverlay) {
      this._paperOverlay.remove();
      this._paperOverlay = null;
    }
    this._paperCanvas = null;
    this._paperPageIndicator = null;
    this._pdfDoc = null;
    this._paperUrl = null;
    this._paperPageCache = {};
    this._paperCurrentPage = 1;
    this._paperTotalPages = 0;
    this._paperCollisionRect.active = false;
  }

  loadState(state) {
    this.nodes = state.nodes.map(n => {
      const node = { ...n, pinned: !!n.pinned, hidden: !!n.hidden };
      if (node.pinned) {
        node.fx = node.x;
        node.fy = node.y;
      }
      // Parse contributors
      if (state.contributors) {
        node.contributors = state.contributors.filter(c => c.node_id === n.id).map(c => ({
          id: c.id, name: c.name, color: c.color
        }));
      }
      return node;
    });
    this.nodeMap = new Map(this.nodes.map(n => [n.id, n]));

    this.edges = (state.edges || []).map(e => ({ ...e, directed: !!e.directed }));
    this.edgeMap = new Map(this.edges.map(e => [e.id, e]));

    this.render();
    setTimeout(() => this.fitView(), 500);
  }

  mergeNodes(keepId, mergeId, updates) {
    // Remove the merged node
    this.removeNode(mergeId);
    // Update the kept node
    this.updateNode(keepId, updates);
  }
}

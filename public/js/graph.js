// graph.js — D3 force-directed graph with rectilinear edges

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
      .force('link', d3.forceLink().id(d => d.id).distance(200).strength(0.3))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('collision', d3.forceCollide().radius(d => Math.max(this.NODE_WIDTH, this.NODE_HEIGHT) / 2 + 20))
      .force('center', d3.forceCenter(0, 0).strength(0.05))
      .on('tick', () => this._tick());
  }

  _initZoom() {
    this.zoom = d3.zoom()
      .scaleExtent([0.2, 3])
      .on('zoom', (event) => {
        this.g.attr('transform', event.transform);
        this.currentTransform = event.transform;
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

  _resize() {
    const rect = this.container.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
  }

  // --- Rectilinear edge path ---
  _rectilinearPath(source, target) {
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

  _tick() {
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
    }).on('mouseleave', function(event, d) {
      d3.select(this).classed('edge-hover', false);
      self.edgeLabelGroup.selectAll('.edge-label-group')
        .filter(e => e.id === d.id)
        .classed('edge-label-hover', false);
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
    }).on('mouseleave', function(event, d) {
      d3.select(this).classed('edge-label-hover', false);
      self.edgeGroup.selectAll('.edge-path')
        .filter(e => e.id === d.id)
        .classed('edge-hover', false);
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

    // --- NODES ---
    const nodeSelection = this.nodeGroup.selectAll('.node-group')
      .data(this.nodes, d => d.id);

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
      if (self.onNodeHover) self.onNodeHover(d.id);
    }).on('mousemove.tooltip', function(event, d) {
      if (self._tooltip.classList.contains('visible')) self._positionTooltip(event);
    }).on('mouseleave', function(event, d) {
      self._hideTooltip();
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
    // Set initial position if not already set
    if (node.x === 0 && node.y === 0) {
      node.x = (Math.random() - 0.5) * 600;
      node.y = (Math.random() - 0.5) * 400;
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
    if (this.nodes.length === 0) return;

    const xs = this.nodes.map(n => n.x);
    const ys = this.nodes.map(n => n.y);
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

  loadState(state) {
    this.nodes = state.nodes.map(n => {
      const node = { ...n, pinned: !!n.pinned };
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

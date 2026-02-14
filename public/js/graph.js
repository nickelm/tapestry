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

    this.onNodeContext = null; // callback(nodeId, x, y)
    this.onNodeClick = null;
    this.onNodeDragEnd = null;
    this.onNodeHover = null;
    this.onNodeUnhover = null;
    this.onNodeUpvote = null;
    this.onCanvasClick = null;

    this.NODE_WIDTH = 180;
    this.NODE_HEIGHT = 52;
    this.NODE_PADDING = 12;

    this._initSVG();
    this._initSimulation();
    this._initZoom();

    window.addEventListener('resize', () => this._resize());
    this._resize();
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
      .attr('stdDeviation', '2')
      .attr('flood-color', 'rgba(0,0,0,0.08)');

    // Arrowhead
    defs.append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '0 0 10 6')
      .attr('refX', '10').attr('refY', '3')
      .attr('markerWidth', '8').attr('markerHeight', '6')
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,0 L10,3 L0,6 Z')
      .attr('class', 'edge-arrowhead');

    // Main group for zoom/pan
    this.g = this.svg.append('g').attr('class', 'graph-root');
    this.edgeGroup = this.g.append('g').attr('class', 'edges');
    this.edgeLabelGroup = this.g.append('g').attr('class', 'edge-labels');
    this.nodeGroup = this.g.append('g').attr('class', 'nodes');
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

  // --- Render ---
  render(restartSimulation = true) {
    const self = this;

    // --- EDGES ---
    const edgeSelection = this.edgeGroup.selectAll('.edge-path')
      .data(this.edges, d => d.id);

    edgeSelection.exit().remove();

    edgeSelection.enter()
      .append('path')
      .attr('class', 'edge-path')
      .attr('marker-end', 'url(#arrowhead)')
      .merge(edgeSelection);

    // Edge labels
    const edgeLabelSel = this.edgeLabelGroup.selectAll('.edge-label-group')
      .data(this.edges, d => d.id);

    edgeLabelSel.exit().remove();

    const edgeLabelEnter = edgeLabelSel.enter()
      .append('g')
      .attr('class', 'edge-label-group');

    edgeLabelEnter.append('rect')
      .attr('fill', '#fafafa')
      .attr('stroke', '#e2e8f0')
      .attr('stroke-width', 0.8)
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

    // Click
    nodeEnter.on('click', function(event, d) {
      event.stopPropagation();
      if (self.onNodeClick) self.onNodeClick(d.id, event);
    });

    // Context menu
    nodeEnter.on('contextmenu', function(event, d) {
      event.preventDefault();
      event.stopPropagation();
      if (self.onNodeContext) self.onNodeContext(d.id, event.clientX, event.clientY);
    });

    // Hover
    nodeEnter.on('mouseenter', function(event, d) {
      if (self.onNodeHover) self.onNodeHover(d.id);
    }).on('mouseleave', function(event, d) {
      if (self.onNodeUnhover) self.onNodeUnhover(d.id);
    });

    // Update existing + new
    const mergedNodes = nodeEnter.merge(nodeSelection);

    mergedNodes.select('.node-title')
      .text(d => this._truncate(d.title, 24));

    mergedNodes.select('.node-description')
      .text(d => this._truncate(d.description, 30));

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

    this.edges = state.edges || [];
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

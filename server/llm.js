const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;

class LLMService {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY });
    this.chatModel = 'claude-sonnet-4-6';
    this.taskModel = 'claude-haiku-4-5-20251001';
  }

  async chatWithExtraction(messages, existingConcepts = [], { signal, roomName, roomSummary, breadcrumb } = {}) {
    const existingList = existingConcepts.length > 0
      ? `\n\nExisting concepts in the shared knowledge graph (avoid duplicating these):\n${existingConcepts.map(c => `- ${c.title}: ${c.description}`).join('\n')}`
      : '';

    const roomContext = this._buildRoomContext(roomName, roomSummary);
    const breadcrumbContext = breadcrumb && breadcrumb.length > 0
      ? `\nThe student is exploring the following path: ${breadcrumb.join(' \u2192 ')}.`
      : '';

    const systemPrompt = `You are a knowledgeable assistant helping a student explore and understand concepts.${roomContext}${breadcrumbContext}
Respond naturally and helpfully to the student's question.

After your response, you MUST include a JSON block with extracted concepts. This block must be wrapped in <concepts> tags.
Each concept should be a key idea, entity, or term from your response that could be a node in a knowledge graph.

Extract 8-12 concepts from your response. Include:
- Primary concepts: the main topics and components you explained
- Secondary concepts: related ideas, people, papers, or techniques mentioned but not fully explained

Format:
<concepts>
[
  {"title": "Short concept name", "type": "primary"},
  {"title": "Related idea or reference", "type": "secondary"}
]
</concepts>

Do NOT include descriptions — titles only. Be specific rather than generic.${existingList}`;

    const response = await this.client.messages.create({
      model: this.chatModel,
      max_tokens: 1500,
      system: systemPrompt,
      messages: messages
    }, { signal });

    const text = response.content[0].text;

    // Parse concepts from response
    let concepts = [];
    const conceptMatch = text.match(/<concepts>\s*([\s\S]*?)\s*<\/concepts>/);
    if (conceptMatch) {
      try {
        concepts = JSON.parse(conceptMatch[1]);
      } catch (e) {
        console.error('Failed to parse concepts:', e);
      }
    }

    // Remove the concepts block from the visible response
    const cleanText = text.replace(/<concepts>[\s\S]*?<\/concepts>/, '').trim();

    return { text: cleanText, concepts };
  }

  async generateRelationshipLabel(concept1, concept2, { roomName, roomSummary } = {}) {
    const roomContext = this._buildRoomContext(roomName, roomSummary);
    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 100,
      system: `You generate concise relationship labels for knowledge graphs.${roomContext} Respond ONLY with valid JSON: {"label": "...", "directed": true/false}. The label should be a short phrase (2-5 words). Set directed to true if the relationship flows from the first concept to the second (e.g., "influenced", "enables", "is a type of", "depends on"). Set directed to false if the relationship is symmetric (e.g., "contrasts with", "were contemporaries", "is similar to"). No explanation.`,
      messages: [{
        role: 'user',
        content: `How does "${concept1.title}" relate to "${concept2.title}"?\n\nContext:\n- ${concept1.title}: ${concept1.description}\n- ${concept2.title}: ${concept2.description}`
      }]
    });

    try {
      const parsed = JSON.parse(this._cleanJSON(response.content[0].text));
      return {
        label: parsed.label || 'relates to',
        directed: parsed.directed !== false
      };
    } catch (e) {
      console.error('Failed to parse relationship label:', e);
      return { label: response.content[0].text.trim() || 'relates to', directed: true };
    }
  }

  async expandConcept(concept, existingConcepts = [], { roomName, roomSummary } = {}) {
    const roomContext = this._buildRoomContext(roomName, roomSummary);
    const existingList = existingConcepts.map(c => c.title).join(', ');
    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 500,
      system: `You help expand knowledge graphs by suggesting related concepts.${roomContext} Given a concept, suggest 2-4 closely related concepts that would be valuable neighbors in a knowledge graph. Each suggestion should include a title, description, relationship label, and whether the relationship is directed (flows from the original concept to the new one) or symmetric.

Existing concepts to avoid duplicating: ${existingList}

Respond ONLY with valid JSON array, no markdown fences:
[{"title": "...", "description": "...", "relationLabel": "...", "directed": true/false}]`,
      messages: [{
        role: 'user',
        content: `Expand on: "${concept.title}" - ${concept.description}`
      }]
    });

    try {
      return JSON.parse(this._cleanJSON(response.content[0].text));
    } catch (e) {
      console.error('Failed to parse expansion:', e);
      return [];
    }
  }

  async elaborateConcept(concept, { roomName, roomSummary } = {}) {
    const roomContext = this._buildRoomContext(roomName, roomSummary);
    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 200,
      system: `You provide concise, enriched descriptions for knowledge graph nodes.${roomContext} Given a concept, provide a richer 2-3 sentence description. Respond with ONLY the description text, no formatting.`,
      messages: [{
        role: 'user',
        content: `Elaborate on: "${concept.title}" - ${concept.description}`
      }]
    });
    return response.content[0].text.trim();
  }

  async suggestMerge(concept1, concept2, { roomName, roomSummary } = {}) {
    const roomContext = this._buildRoomContext(roomName, roomSummary);
    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 200,
      system: `You help merge similar concepts in knowledge graphs.${roomContext} Given two similar concepts, produce a merged version. Respond ONLY with valid JSON: {"title": "...", "description": "..."}`,
      messages: [{
        role: 'user',
        content: `Merge these concepts:\n1. "${concept1.title}": ${concept1.description}\n2. "${concept2.title}": ${concept2.description}`
      }]
    });

    try {
      return JSON.parse(this._cleanJSON(response.content[0].text));
    } catch (e) {
      console.error('Failed to parse merge suggestion:', e);
      return { title: concept1.title, description: concept1.description };
    }
  }

  async describeConcept(title, breadcrumb = [], excerpt = '', { roomName, roomSummary } = {}) {
    let content;
    if (excerpt) {
      const context = breadcrumb.length > 0 ? breadcrumb.join(' \u2192 ') : 'a topic';
      content = `Given the following excerpt from a discussion about ${context}:\n"${excerpt}"\n\nWrite a one-sentence description of the concept "${title}" suitable for a knowledge graph node.`;
    } else {
      const prefix = breadcrumb.length > 0
        ? `Given the context of a discussion about ${breadcrumb.join(' \u2192 ')}, provide`
        : 'Provide';
      content = `${prefix} a one-sentence description of the concept "${title}".`;
    }
    const roomContext = this._buildRoomContext(roomName, roomSummary);
    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 100,
      system: `You provide concise concept descriptions.${roomContext} Respond with ONLY a single sentence. No formatting.`,
      messages: [{ role: 'user', content }]
    });
    return response.content[0].text.trim();
  }

  async generateConceptDescription(title, roomTopic = '', existingNodeTitles = []) {
    const topicLine = roomTopic ? `\nThe knowledge graph topic is "${roomTopic}".` : '';
    const existingLine = existingNodeTitles.length > 0
      ? `\n\nExisting concepts in the graph:\n${existingNodeTitles.join(', ')}`
      : '';

    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 100,
      system: `You provide concise concept descriptions for knowledge graph nodes.${topicLine} Respond with ONLY a single sentence, max 25 words. No formatting, no quotes.`,
      messages: [{
        role: 'user',
        content: `A student has manually added the concept: "${title}"${existingLine}\n\nWrite a one-sentence description of this concept.`
      }]
    });
    return response.content[0].text.trim();
  }

  async shortenTitle(title) {
    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 50,
      system: 'Shorten the following concept title to at most 40 characters while preserving its core meaning. Respond with ONLY the shortened title, no explanation or quotes.',
      messages: [{ role: 'user', content: title }]
    });
    return response.content[0].text.trim();
  }

  async findSimilarConcepts(newConcept, existingConcepts, { roomName, roomSummary } = {}) {
    if (existingConcepts.length === 0) return { duplicates: [], related: [], broader: [] };

    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 500,
      system: `You classify how a new concept relates to existing concepts in a knowledge graph.${this._buildRoomContext(roomName, roomSummary)}

Given a new concept and a list of existing concepts, classify each relevant existing concept into one of three categories:

1. duplicates: The same concept worded differently. These should be merged. Be very conservative. Two things of the same type (two philosophers, two algorithms, two aircraft) are NEVER duplicates. Only flag cases where both terms refer to the identical entity or idea (e.g., "ML" and "Machine Learning", "Kant" and "Immanuel Kant").

2. related: Concepts that directly depend on, interact with, or causally influence the new concept. "Directly" means: you could write a single sentence explaining the specific relationship. Mere thematic proximity (same field, same era, same category) does NOT qualify.

3. broader: A parent category or generalization that contains the new concept.

Respond ONLY with valid JSON, no markdown fences:
{"duplicates": [{"id": "...", "reason": "why this is the same concept"}], "related": [{"id": "...", "relationship": "how they relate"}], "broader": [{"id": "...", "relationship": "how the new concept fits under this"}]}

If no concepts match a category, use an empty array. Only include genuinely relevant concepts.`,
      messages: [{
        role: 'user',
        content: `New concept: "${newConcept.title}" - ${newConcept.description}\n\nExisting concepts:\n${existingConcepts.map(c => `- ID: ${c.id}, "${c.title}": ${c.description}`).join('\n')}`
      }]
    });

    try {
      const result = JSON.parse(this._cleanJSON(response.content[0].text));
      return {
        duplicates: Array.isArray(result.duplicates) ? result.duplicates : [],
        related: Array.isArray(result.related) ? result.related : [],
        broader: Array.isArray(result.broader) ? result.broader : []
      };
    } catch (e) {
      return { duplicates: [], related: [], broader: [] };
    }
  }

  async suggestConnections(concept, existingNodes, { roomName, roomSummary } = {}, priorityCandidates = []) {
    if (existingNodes.length === 0) return [];

    const roomContext = this._buildRoomContext(roomName, roomSummary);
    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 600,
      system: `You analyze knowledge graphs and suggest meaningful connections between concepts.${roomContext} Given a concept and existing concepts in the graph, suggest the most valuable connections.

For each suggested connection, provide:
- targetId: the ID of the existing concept to connect to
- label: a concise relationship phrase (2-5 words, e.g. "influenced", "contrasts with", "is a type of")
- directed: true if the relationship flows from the new concept to the target, false if symmetric
- strength: integer 1-5 (5 = strongest/most important connection)

Only suggest connections that are semantically meaningful and would add value to the knowledge graph. Do not suggest vague connections like "relates to".

Respond ONLY with a valid JSON array, no markdown fences:
[{"targetId": "...", "label": "...", "directed": true/false, "strength": 5}]

If no good connections exist, return [].`,
      messages: [{
        role: 'user',
        content: `Concept: "${concept.title}" - ${concept.description || 'No description'}\n\nExisting concepts in the graph:\n${existingNodes.map(n => `- ID: ${n.id}, "${n.title}": ${n.description || 'No description'}`).join('\n')}${priorityCandidates.length > 0 ? `\n\nThe following concepts have been pre-identified as directly related. Prioritize connections to these:\n${priorityCandidates.map(n => `- ID: ${n.id}, "${n.title}"`).join('\n')}` : ''}`
      }]
    });

    try {
      const suggestions = JSON.parse(this._cleanJSON(response.content[0].text));
      const seen = new Set();
      return suggestions
        .filter(s => s.targetId && s.label && s.strength >= 1 && s.strength <= 5)
        .filter(s => { if (seen.has(s.targetId)) return false; seen.add(s.targetId); return true; })
        .sort((a, b) => b.strength - a.strength)
        .slice(0, 5);
    } catch (e) {
      console.error('Failed to parse connection suggestions:', e);
      return [];
    }
  }

  async extractConceptsFromPaper(text) {
    // Pass 1 — Skeleton: extract primary concepts and relationships from first ~8000 tokens
    const truncatedText = text.slice(0, 32000);

    const pass1System = `You are extracting the conceptual structure from an academic paper.

Extract the 8-15 most important concepts from this paper. For each concept:
- title: concise name (2-5 words)
- description: one sentence explaining this concept in the paper's context
- type: one of [Entity, Concept, Method, Artifact, Event, Property]
- paperRelationship: how the paper relates to this concept (2-4 word directional label, e.g. "introduces", "critiques", "builds upon", "evaluates", "proposes")

Also identify 5-10 key relationships between concepts:
- source: title of source concept
- target: title of target concept
- label: relationship description (2-4 words)
- directed: true if directional, false if symmetric

Return JSON:
{
  "paperTitle": "...",
  "paperAuthors": "...",
  "concepts": [{"title": "...", "description": "...", "type": "...", "paperRelationship": "..."}],
  "relationships": [{"source": "...", "target": "...", "label": "...", "directed": true}]
}

Focus on this paper's contributions, methods, and findings — not generic background concepts. Respond ONLY with valid JSON, no markdown fences.`;

    const pass1Result = await this._callAndParseJSON(
      this.chatModel, pass1System,
      `Paper text:\n${truncatedText}`,
      2000
    );

    const primaryConcepts = Array.isArray(pass1Result.concepts) ? pass1Result.concepts : [];
    const pass1Relationships = Array.isArray(pass1Result.relationships) ? pass1Result.relationships : [];

    // Pass 2 — Detail: extract secondary concepts for each primary
    const primaryList = primaryConcepts.map(c => `- ${c.title}: ${c.description}`).join('\n');

    const pass2System = `You previously extracted these primary concepts from a paper:
${primaryList}

For each primary concept, extract 2-4 secondary concepts specifically discussed in connection with it — techniques, datasets, metrics, sub-components, or related work unique to this paper.

For each secondary concept:
- title: concise name (2-5 words)
- description: one sentence
- type: one of [Entity, Concept, Method, Artifact, Event, Property]
- parentConcept: which primary concept this relates to
- relationship: how it relates to the parent (2-4 word label)

Return JSON:
{
  "secondaryConcepts": [{"title": "...", "description": "...", "type": "...", "parentConcept": "...", "relationship": "..."}]
}

Respond ONLY with valid JSON, no markdown fences.`;

    const pass2Result = await this._callAndParseJSON(
      this.chatModel, pass2System,
      `Full paper text:\n${text}`,
      4000
    );

    const secondaryConcepts = Array.isArray(pass2Result.secondaryConcepts) ? pass2Result.secondaryConcepts : [];

    // Combine results
    const allConcepts = [
      ...primaryConcepts.map(c => ({ title: c.title, description: c.description, type: c.type, tier: 'primary', paperRelationship: c.paperRelationship || 'discusses' })),
      ...secondaryConcepts.map(c => ({ title: c.title, description: c.description, type: c.type, tier: 'secondary', parentConcept: c.parentConcept }))
    ];

    const allRelationships = [
      ...pass1Relationships,
      ...secondaryConcepts.map(c => ({ source: c.title, target: c.parentConcept, label: c.relationship, directed: true }))
    ];

    return {
      paperTitle: pass1Result.paperTitle || '',
      paperAuthors: pass1Result.paperAuthors || '',
      concepts: allConcepts,
      relationships: allRelationships
    };
  }

  async _callAndParseJSON(model, system, userMessage, maxTokens) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.client.messages.create({
        model, max_tokens: maxTokens, system,
        messages: [{ role: 'user', content: userMessage }]
      });
      try {
        return JSON.parse(this._cleanJSON(response.content[0].text));
      } catch (e) {
        if (attempt === 0) {
          console.error('JSON parse failed, retrying:', e.message);
          continue;
        }
        throw new Error(`Failed to parse LLM JSON after retry: ${e.message}`);
      }
    }
  }

  _buildRoomContext(roomName, roomSummary) {
    let context = '';
    if (roomName) context += `\nThe topic of this session is "${roomName}".`;
    if (roomSummary) context += `\nSession context: ${roomSummary}`;
    return context;
  }

  _cleanJSON(text) {
    return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  }
}

module.exports = { LLMService };

const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;

class LLMService {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY });
    this.chatModel = 'claude-sonnet-4-20250514';
    this.taskModel = 'claude-haiku-4-5-20251001';
  }

  async chatWithExtraction(messages, existingConcepts = [], { signal, roomName, breadcrumb } = {}) {
    const existingList = existingConcepts.length > 0
      ? `\n\nExisting concepts in the shared knowledge graph (avoid duplicating these):\n${existingConcepts.map(c => `- ${c.title}: ${c.description}`).join('\n')}`
      : '';

    const roomContext = roomName ? `\nThe topic of this session is "${roomName}".` : '';
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

  async generateRelationshipLabel(concept1, concept2) {
    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 100,
      system: 'You generate concise relationship labels for knowledge graphs. Respond ONLY with valid JSON: {"label": "...", "directed": true/false}. The label should be a short phrase (2-5 words). Set directed to true if the relationship flows from the first concept to the second (e.g., "influenced", "enables", "is a type of", "depends on"). Set directed to false if the relationship is symmetric (e.g., "contrasts with", "were contemporaries", "is similar to"). No explanation.',
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

  async expandConcept(concept, existingConcepts = []) {
    const existingList = existingConcepts.map(c => c.title).join(', ');
    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 500,
      system: `You help expand knowledge graphs by suggesting related concepts. Given a concept, suggest 2-4 closely related concepts that would be valuable neighbors in a knowledge graph. Each suggestion should include a title, description, relationship label, and whether the relationship is directed (flows from the original concept to the new one) or symmetric.

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

  async elaborateConcept(concept) {
    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 200,
      system: 'You provide concise, enriched descriptions for knowledge graph nodes. Given a concept, provide a richer 2-3 sentence description. Respond with ONLY the description text, no formatting.',
      messages: [{
        role: 'user',
        content: `Elaborate on: "${concept.title}" - ${concept.description}`
      }]
    });
    return response.content[0].text.trim();
  }

  async suggestMerge(concept1, concept2) {
    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 200,
      system: 'You help merge similar concepts in knowledge graphs. Given two similar concepts, produce a merged version. Respond ONLY with valid JSON: {"title": "...", "description": "..."}',
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

  async describeConcept(title, breadcrumb = [], excerpt = '') {
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
    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 100,
      system: 'You provide concise concept descriptions. Respond with ONLY a single sentence. No formatting.',
      messages: [{ role: 'user', content }]
    });
    return response.content[0].text.trim();
  }

  async findSimilarConcepts(newConcept, existingConcepts) {
    if (existingConcepts.length === 0) return [];

    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 200,
      system: `You identify similar concepts in a knowledge graph. Given a new concept and a list of existing concepts, return the IDs of any existing concepts that are semantically very similar or overlapping. Respond ONLY with a JSON array of IDs, e.g. ["id1", "id2"]. If none are similar, respond with [].`,
      messages: [{
        role: 'user',
        content: `New concept: "${newConcept.title}" - ${newConcept.description}\n\nExisting concepts:\n${existingConcepts.map(c => `- ID: ${c.id}, "${c.title}": ${c.description}`).join('\n')}`
      }]
    });

    try {
      return JSON.parse(this._cleanJSON(response.content[0].text));
    } catch (e) {
      return [];
    }
  }

  async suggestConnections(concept, existingNodes) {
    if (existingNodes.length === 0) return [];

    const response = await this.client.messages.create({
      model: this.taskModel,
      max_tokens: 600,
      system: `You analyze knowledge graphs and suggest meaningful connections between concepts. Given a concept and existing concepts in the graph, suggest the most valuable connections.

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
        content: `Concept: "${concept.title}" - ${concept.description || 'No description'}\n\nExisting concepts in the graph:\n${existingNodes.map(n => `- ID: ${n.id}, "${n.title}": ${n.description || 'No description'}`).join('\n')}`
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

  _cleanJSON(text) {
    return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  }
}

module.exports = { LLMService };

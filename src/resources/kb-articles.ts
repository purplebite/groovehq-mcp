import { GrooveClient } from '../groove-client.js';
import { queries } from '../utils/graphql-queries.js';
import { KnowledgeBaseArticle } from '../types/groove.js';
import { defineTool, READ_TOOL } from '../tools/definition.js';

interface ListKbArticlesArgs {
  categoryId?: string;
  published?: boolean;
  featured?: boolean;
  limit?: number;
  after?: string;
}

// What the help site shows: published articles, and changed ones in their published version
export const LIVE_STATES = ['PUBLISHED', 'WIP'];

function live(article: KnowledgeBaseArticle): KnowledgeBaseArticle {
  const { currentVersion, ...rest } = article;
  return currentVersion ? { ...rest, ...currentVersion } : rest;
}

interface SearchKbArticlesArgs {
  query: string;
  limit?: number;
  after?: string;
}

export class KnowledgeBaseResources {
  constructor(private client: GrooveClient) {}

  async listArticles(args: ListKbArticlesArgs = {}): Promise<KnowledgeBaseArticle[]> {
    const filter: { category?: string; featured?: boolean; state?: string[] } = {};

    if (args.categoryId) filter.category = args.categoryId;
    if (args.featured !== undefined) filter.featured = args.featured;
    if (args.published) filter.state = LIVE_STATES;

    const response = await this.client.request<{
      articles: {
        nodes: KnowledgeBaseArticle[];
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string;
        };
      };
    }>(queries.listKbArticles, { filter, first: args.limit || 20, after: args.after });

    return response.articles.nodes.map(live);
  }

  async getArticle(id: string): Promise<KnowledgeBaseArticle | null> {
    const response = await this.client.request<{
      node: KnowledgeBaseArticle | null;
    }>(queries.getKbArticle, { id });

    return response.node && live(response.node);
  }

  async searchArticles(args: SearchKbArticlesArgs): Promise<KnowledgeBaseArticle[]> {
    const response = await this.client.request<{
      articles: {
        nodes: KnowledgeBaseArticle[];
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string;
        };
      };
    }>(queries.listKbArticles, {
      // Only what the help site shows, like the resource list
      filter: { keywords: args.query, state: LIVE_STATES },
      first: args.limit || 20,
      after: args.after,
    });

    return response.articles.nodes.map(live);
  }

  // Helper method to build resource URIs
  buildResourceUri(type: 'article' | 'category', id: string): string {
    return `groove://kb/${type}/${id}`;
  }

  // Format article for MCP resource
  formatArticleResource(article: KnowledgeBaseArticle) {
    return {
      uri: this.buildResourceUri('article', article.id),
      name: article.title,
      description: article.description || '',
      mimeType: 'text/markdown',
      // MCP clients drop fields outside the spec, so extra data goes in _meta
      _meta: {
        category: article.category?.title,
        state: article.state,
        featured: article.featured,
      },
    };
  }
}

export const searchKbArticles = defineTool<SearchKbArticlesArgs>({
  name: 'searchKbArticles',
  setting: 'read',
  annotations: READ_TOOL,
  description: 'Search knowledge base articles',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of articles to return',
        default: 20,
      },
    },
    required: ['query'],
  },
  handler: (args, { kb }) => kb.searchArticles(args),
});

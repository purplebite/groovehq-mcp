import { GrooveClient } from '../groove-client.js';
import { queries } from '../utils/graphql-queries.js';
import { KnowledgeBaseArticle } from '../types/groove.js';

interface ListKbArticlesArgs {
  categoryId?: string;
  published?: boolean;
  featured?: boolean;
  limit?: number;
  after?: string;
}

interface SearchKbArticlesArgs {
  query: string;
  limit?: number;
  after?: string;
}

export class KnowledgeBaseResources {
  constructor(private client: GrooveClient) {}

  async listArticles(args: ListKbArticlesArgs = {}): Promise<KnowledgeBaseArticle[]> {
    const filter: any = {};

    if (args.categoryId) filter.category = args.categoryId;
    if (args.featured !== undefined) filter.featured = args.featured;
    if (args.published) filter.state = 'PUBLISHED';

    const response = await this.client.request<{
      articles: {
        nodes: KnowledgeBaseArticle[];
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string;
        };
      };
    }>(queries.listKbArticles, { filter, first: args.limit || 20, after: args.after });

    return response.articles.nodes;
  }

  async getArticle(id: string): Promise<KnowledgeBaseArticle | null> {
    const response = await this.client.request<{
      node: KnowledgeBaseArticle | null;
    }>(queries.getKbArticle, { id });

    return response.node;
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
      filter: { keywords: args.query },
      first: args.limit || 20,
      after: args.after,
    });

    return response.articles.nodes;
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
      metadata: {
        category: article.category?.title,
        state: article.state,
        featured: article.featured,
      },
    };
  }
}
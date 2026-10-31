import { GrooveClient } from '../groove-client.js';
import { queries } from '../utils/graphql-queries.js';
import { Tag } from '../types/groove.js';

interface ListTagsArgs {
  search?: string;
}

export class TagTools {
  constructor(private client: GrooveClient) {}

  // Groove's pageInfo can report no next page while tags remain, so pages are
  // read until one comes back short
  async listTags(args: ListTagsArgs = {}): Promise<Tag[]> {
    const filter = args.search ? { search: args.search } : undefined;
    const pageSize = 100;
    const tags: Tag[] = [];
    let after: string | undefined;

    while (true) {
      const response = await this.client.request<{
        tags: {
          nodes: Tag[];
          pageInfo: {
            endCursor: string | null;
          };
        };
      }>(queries.listTags, { first: pageSize, after, filter });

      tags.push(...response.tags.nodes);

      if (response.tags.nodes.length < pageSize || !response.tags.pageInfo.endCursor) {
        return tags;
      }

      after = response.tags.pageInfo.endCursor;
    }
  }
}

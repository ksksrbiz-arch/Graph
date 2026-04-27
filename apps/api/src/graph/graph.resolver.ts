// GraphQL resolver for graph queries — code-first, spec §6.1 (GraphQL column).
// All queries are guarded by JwtAuthGuard and extract the userId from the JWT.
//
// Queries:
//   nodes(cursor, limit, type)  → GqlNodePage
//   node(id)                    → GqlKGNode
//   subgraph(rootId, depth)     → GqlSubgraph
//   searchNodes(q, limit)       → [GqlSearchHit]

import { UseGuards } from '@nestjs/common';
import { Args, Context, Int, Query, Resolver } from '@nestjs/graphql';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GraphService } from './graph.service';
import {
  GqlKGNode,
  GqlNodePage,
  GqlSearchHit,
  GqlSubgraph,
} from './graph.types';

interface GqlContext {
  req: Request & { user: { sub: string } };
}

@Resolver()
@UseGuards(JwtAuthGuard)
export class GraphResolver {
  constructor(private readonly graph: GraphService) {}

  @Query(() => GqlNodePage, { name: 'nodes', description: 'Paginated node list' })
  async nodes(
    @Context() ctx: GqlContext,
    @Args('cursor', { nullable: true }) cursor?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 100 }) limit?: number,
    @Args('type', { nullable: true }) type?: string,
  ): Promise<GqlNodePage> {
    const page = await this.graph.listNodes(
      ctx.req.user.sub,
      cursor,
      limit ?? 100,
      type as Parameters<GraphService['listNodes']>[3],
    );
    return {
      items: page.items as GqlKGNode[],
      nextCursor: page.nextCursor,
    };
  }

  @Query(() => GqlKGNode, { name: 'node', nullable: true, description: 'Single node detail' })
  async node(
    @Context() ctx: GqlContext,
    @Args('id') id: string,
  ): Promise<GqlKGNode | null> {
    try {
      const found = await this.graph.getNode(ctx.req.user.sub, id);
      return found as GqlKGNode;
    } catch {
      return null;
    }
  }

  @Query(() => GqlSubgraph, { name: 'subgraph', description: 'Ego-network subgraph' })
  async subgraph(
    @Context() ctx: GqlContext,
    @Args('rootId') rootId: string,
    @Args('depth', { type: () => Int, nullable: true, defaultValue: 2 }) depth?: number,
  ): Promise<GqlSubgraph> {
    const sg = await this.graph.subgraph(ctx.req.user.sub, rootId, depth ?? 2);
    return sg as GqlSubgraph;
  }

  @Query(() => [GqlSearchHit], {
    name: 'searchNodes',
    description: 'Full-text node search (Meilisearch-backed)',
  })
  async searchNodes(
    @Context() ctx: GqlContext,
    @Args('q') q: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
  ): Promise<GqlSearchHit[]> {
    const hits = await this.graph.searchNodes(ctx.req.user.sub, q, limit ?? 20);
    return hits as GqlSearchHit[];
  }
}

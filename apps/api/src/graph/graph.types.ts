// GraphQL code-first object types for nodes, edges, and subgraph.
// These mirror the TypeScript interfaces in @pkg/shared but are annotated with
// NestJS GraphQL decorators so the schema can be auto-generated.

import { Field, Float, ID, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class GqlKGNode {
  @Field(() => ID) id!: string;
  @Field() label!: string;
  @Field() type!: string;
  @Field() createdAt!: string;
  @Field() updatedAt!: string;
  @Field() sourceId!: string;
  @Field({ nullable: true }) sourceUrl?: string;
  @Field({ nullable: true }) deletedAt?: string;
}

@ObjectType()
export class GqlKGEdge {
  @Field(() => ID) id!: string;
  @Field() source!: string;
  @Field() target!: string;
  @Field() relation!: string;
  @Field(() => Float) weight!: number;
  @Field() inferred!: boolean;
  @Field() createdAt!: string;
}

@ObjectType()
export class GqlSubgraph {
  @Field(() => [GqlKGNode]) nodes!: GqlKGNode[];
  @Field(() => [GqlKGEdge]) edges!: GqlKGEdge[];
}

@ObjectType()
export class GqlNodePage {
  @Field(() => [GqlKGNode]) items!: GqlKGNode[];
  @Field({ nullable: true }) nextCursor?: string | null;
}

@ObjectType()
export class GqlSearchHit {
  @Field(() => ID) id!: string;
  @Field() label!: string;
  @Field() type!: string;
  @Field() sourceId!: string;
  @Field({ nullable: true }) sourceUrl?: string;
  @Field() createdAt!: string;
}

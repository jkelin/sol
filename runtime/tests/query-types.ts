import { $mutation, $query, type QueryKey } from "@soljs/sol";

const typedKey: QueryKey = ["post", { id: 1, published: true }, null];
void typedKey;

function assertPublicInterface(): void {
  const query = $query(
    {
      queryKey: ["post", { preview: true }],
      query: async (id: number, preview: boolean) => ({ id, preview }),
    },
    1,
    true,
  );
  const mutation = $mutation({
    mutation: async (title: string) => ({ id: 1, title }),
  });
  const queryId: number | undefined = query.data?.id;
  const mutationTitle: string | undefined = mutation.data?.title;
  void queryId;
  void mutationTitle;
  void query.refetch({}, 2, false);
  void query.refetch();
  void mutation.mutate({}, "title");
  // @ts-expect-error query arguments retain their tuple type
  void query.refetch({}, "wrong", true);
  // @ts-expect-error controller data is readonly
  query.data = { id: 2, preview: false };
  // @ts-expect-error mutation arguments retain their tuple type
  void mutation.mutate({}, 1);
}

void assertPublicInterface;

// @ts-expect-error undefined is not JSON
const undefinedKey: QueryKey = ["post", undefined];
// @ts-expect-error functions are not JSON
const functionKey: QueryKey = ["post", () => 1];
// @ts-expect-error bigint is not JSON
const bigintKey: QueryKey = ["post", 1n];
// @ts-expect-error class instances are not JSON objects
const dateKey: QueryKey = ["post", new Date()];

void undefinedKey;
void functionKey;
void bigintKey;
void dateKey;

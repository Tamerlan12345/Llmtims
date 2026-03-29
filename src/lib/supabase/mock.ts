const createResult = <T>(data: T) => Promise.resolve({ data, error: null });

const createMockQueryBuilder = (): any => {
  const builder: any = {
    select: () => builder,
    insert: () => builder,
    update: () => builder,
    upsert: () => builder,
    delete: () => builder,
    eq: () => builder,
    neq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => createResult(null),
    single: () => createResult(null),
    then: (onfulfilled?: ((value: { data: []; error: null }) => unknown) | null) =>
      Promise.resolve({ data: [], error: null }).then(onfulfilled ?? undefined),
  };

  return builder;
};

const createMockChannel = (): any => {
  const channel: any = {
    on: () => channel,
    subscribe: () => channel,
    unsubscribe: () => undefined,
  };

  return channel;
};

export const createMockSupabaseClient = (): any => ({
  from: () => createMockQueryBuilder(),
  channel: () => createMockChannel(),
  removeChannel: () => undefined,
  rpc: async () => ({ data: null, error: null }),
});

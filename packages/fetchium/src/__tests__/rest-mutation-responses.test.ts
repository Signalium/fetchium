import { describe, it, expect, vi } from 'vitest';
import { getMutation } from '../mutation.js';
import { fetchQuery } from '../query.js';
import { RESTMutation, RESTQuery, RESTQueryAdapter } from '../rest/index.js';
import { setupTestClient, testWithClient } from './utils.js';

describe('REST mutation response parsing', () => {
  let response: Response;
  const fetch = async () => response;
  const getClient = setupTestClient(() => ({
    adapters: [new RESTQueryAdapter({ fetch, baseUrl: 'http://localhost' })],
  }));

  class UpdateItem extends RESTMutation {
    path = '/items/1';
    method = 'PUT' as const;
    result = {};
  }

  it('returns {} for 204 mutations without parsing JSON', async () => {
    response = new Response(null, { status: 204 });
    const json = vi.spyOn(response, 'json');
    const { client } = getClient();

    await testWithClient(client, async () => {
      const mutation = getMutation(UpdateItem);

      await expect(mutation.run({})).resolves.toEqual({});
      expect(mutation.isResolved).toBe(true);
      expect(mutation.value).toEqual({});
      expect(json).not.toHaveBeenCalled();
    });
  });

  it.each(['', '{'])('rejects 200 mutations with invalid JSON: %j', async body => {
    response = new Response(body, { status: 200 });
    const { client } = getClient();

    await testWithClient(client, async () => {
      const mutation = getMutation(UpdateItem);

      await expect(mutation.run({})).rejects.toBeInstanceOf(SyntaxError);
      expect(mutation.isRejected).toBe(true);
    });
  });

  it('rejects 204 queries when JSON parsing fails', async () => {
    response = new Response(null, { status: 204 });
    const json = vi.spyOn(response, 'json');
    const { client } = getClient();

    class GetItem extends RESTQuery {
      path = '/items/1';
      result = {};
      config = { retry: false as const };
    }

    await testWithClient(client, async () => {
      await expect(fetchQuery(GetItem)).rejects.toBeInstanceOf(SyntaxError);
      expect(json).toHaveBeenCalledOnce();
    });
  });
});

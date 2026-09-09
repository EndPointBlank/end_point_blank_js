'use strict';

jest.mock('../../src/commands/basic-authenticate', () => ({
  BasicAuthenticate: { authenticate: jest.fn() },
}));
jest.mock('../../src/commands/endpoint-authorize', () => ({
  EndpointAuthorize: { authorize: jest.fn() },
}));

const { BasicAuthenticate } = require('../../src/commands/basic-authenticate');
const { EndpointAuthorize } = require('../../src/commands/endpoint-authorize');
const { authenticated } = require('../../src/express/authenticated');
const { authorized } = require('../../src/express/authorized');

/**
 * The two Express guards make the same decision about the same answer, and the
 * only thing that should differ is the word in the message.
 *
 * They drifted once already: `authorized` carried intake's status and read the
 * response body once, `authenticated` dropped the status and read the body
 * twice. Neither divergence was visible in a pass/fail count, because both
 * guards refused the request either way — only the status the caller was
 * finally served differed. This pins them together so the next fix cannot land
 * on one of them alone.
 */
describe('the two guards refuse identically', () => {
  const req = { headers: {}, method: 'GET', path: '/students' };
  const res = { setHeader: () => {}, headersSent: false };

  const refusalFor = async answer => {
    BasicAuthenticate.authenticate.mockResolvedValue(answer);
    EndpointAuthorize.authorize.mockResolvedValue(answer);

    const authenticateNext = jest.fn();
    await authenticated(req, res, authenticateNext);

    const authorizeNext = jest.fn();
    await authorized(req, res, authorizeNext);

    return [authenticateNext.mock.calls[0][0], authorizeNext.mock.calls[0][0]];
  };

  beforeEach(() => {
    BasicAuthenticate.authenticate.mockReset();
    EndpointAuthorize.authorize.mockReset();
  });

  test.each([
    ['a denied grant', { status: 403, text: async () => '{"error":"access_denied"}' }, 403],
    ['a rejected credential', { status: 401, text: async () => '{"error":"invalid"}' }, 401],
    ['a failure inside intake', { status: 500, text: async () => 'boom' }, 500],
    ['a non-JSON error body', { status: 502, text: async () => 'Bad Gateway' }, 502],
    ['no answer at all', null, 503],
  ])('%s becomes the same status on both', async (_name, answer, expected) => {
    const [fromAuthenticate, fromAuthorize] = await refusalFor(answer);

    expect(fromAuthenticate.statusCode).toBe(expected);
    expect(fromAuthorize.statusCode).toBe(fromAuthenticate.statusCode);
  });

  test('and the same reason, under each guard’s own name', async () => {
    const [fromAuthenticate, fromAuthorize] = await refusalFor({
      status: 403,
      text: async () => '{"error":"access_denied"}',
    });

    expect(fromAuthenticate.message).toBe('Authentication failed: access_denied');
    expect(fromAuthorize.message).toBe('Authorization failed: access_denied');
  });
});

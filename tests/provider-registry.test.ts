import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRegistry, ProviderRegistryError } from "../src/provider-registry.js";

const registry = {
  providers: {
    resend: {
      apiBaseUrl: "https://api.resend.com",
      allowedMethods: ["POST"],
      allowedPathPrefixes: ["/emails"],
      gatewayCapabilities: {
        "email.send": { allowedMethods: ["POST"], allowedPathPrefixes: ["/emails"] },
      },
      authentication: {
        type: "bearer",
        credential: "api_key",
      },
    },
    github: {
      apiBaseUrl: "https://api.github.com",
      allowedMethods: ["GET", "POST"],
      allowedPathPrefixes: ["/user", "/repos"],
      gatewayCapabilities: {
        "repository.read": { allowedMethods: ["GET"], allowedPathPrefixes: ["/repos"] },
      },
      authentication: { type: "bearer", credential: "access_token" },
      oauth: {
        authorizationEndpoint: "https://github.com/login/oauth/authorize",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        clientId: "client-id",
        clientSecretFile: "/run/credentials/github-client-secret",
        clientAuthentication: "basic",
        allowedScopes: ["repo", "read:user"],
      },
    },
  },
};

test("loads trusted provider endpoints and OAuth policy", () => {
  const providers = ProviderRegistry.from(registry);
  assert.equal(providers.provider("resend").authentication.header, "authorization");
  assert.deepEqual(
    providers.provider("resend").gatewayCapabilities["email.send"]?.allowedMethods,
    ["POST"],
  );
  assert.equal(providers.provider("github").oauth?.allowedScopes[0], "repo");
  assert.throws(() => providers.provider("missing"), ProviderRegistryError);
});

test("rejects provider credentials in URLs and unsafe path policy", () => {
  assert.throws(
    () => ProviderRegistry.from({
      providers: {
        bad: {
          apiBaseUrl: "https://user:secret@example.test",
          allowedMethods: ["GET"],
          allowedPathPrefixes: ["/"],
          authentication: { type: "none" },
        },
      },
    }),
    /without credentials/,
  );
  assert.throws(
    () => ProviderRegistry.from({
      providers: {
        bad: {
          apiBaseUrl: "https://example.test",
          allowedMethods: ["GET"],
          allowedPathPrefixes: ["/../admin"],
          authentication: { type: "none" },
        },
      },
    }),
    /unsafe path/,
  );
  assert.throws(
    () => ProviderRegistry.from({
      providers: {
        bad: {
          apiBaseUrl: "https://example.test",
          authentication: { type: "header", credential: "api_key", header: "host" },
        },
      },
    }),
    /forbidden authentication header/,
  );
  assert.throws(
    () => ProviderRegistry.from({
      providers: {
        bad: {
          apiBaseUrl: "https://example.test",
          authentication: { type: "bearer", credential: "access_token" },
          oauth: {
            authorizationEndpoint: "https://example.test/oauth/authorize",
            tokenEndpoint: "https://example.test/oauth/token",
            clientId: "client",
            clientAuthentication: "none",
            extraAuthorizationParameters: { redirect_uri: "https://evil.test" },
          },
        },
      },
    }),
    /cannot override OAuth protocol fields/,
  );
});

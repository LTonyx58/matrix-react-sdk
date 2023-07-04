/*
Copyright 2023 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {
    AuthorizationParams,
    generateAuthorizationParams,
    generateAuthorizationUrl,
    completeAuthorizationCodeGrant,
} from "matrix-js-sdk/src/oidc/authorize";
import { QueryDict } from "matrix-js-sdk/src/utils";

import { ValidatedDelegatedAuthConfig } from "../ValidatedServerConfig";
import { OidcClientError } from "./error";

/**
 * Store authorization params for retrieval when returning from OIDC OP
 * @param authorizationParams from `generateAuthorizationParams`
 * @param delegatedAuthConfig used for future interactions with OP
 * @param clientId this client's id as registered with configured issuer
 * @param homeserver target homeserver
 */
const storeAuthorizationParams = (
    { redirectUri, state, nonce, codeVerifier }: AuthorizationParams,
    delegatedAuthConfig: ValidatedDelegatedAuthConfig,
    clientId: string,
    homeserverUrl: string,
    identityServerUrl?: string,
): void => {
    window.sessionStorage.setItem(`oidc_${state}_nonce`, nonce);
    window.sessionStorage.setItem(`oidc_${state}_redirectUri`, redirectUri);
    window.sessionStorage.setItem(`oidc_${state}_codeVerifier`, codeVerifier);
    window.sessionStorage.setItem(`oidc_${state}_clientId`, clientId);
    window.sessionStorage.setItem(`oidc_${state}_delegatedAuthConfig`, JSON.stringify(delegatedAuthConfig));
    window.sessionStorage.setItem(`oidc_${state}_homeserverUrl`, homeserverUrl);
    if (identityServerUrl) {
        window.sessionStorage.setItem(`oidc_${state}_identityServerUrl`, identityServerUrl);
    }
};

type StoredAuthorizationParams = Omit<ReturnType<typeof generateAuthorizationParams>, "state" | "scope"> & {
    delegatedAuthConfig: ValidatedDelegatedAuthConfig;
    clientId: string;
    homeserverUrl: string;
    identityServerUrl: string;
};

/**
 * Validate that stored params are present and valid
 * @param params as retrieved from session storage
 * @returns validated stored authorization params
 * @throws when params are invalid or missing
 */
const validateStoredAuthorizationParams = (params: Partial<StoredAuthorizationParams>): StoredAuthorizationParams => {
    const requiredStringProperties = ["nonce", "redirectUri", "codeVerifier", "clientId", "homeserverUrl"];
    if (
        requiredStringProperties.every((key: string) => params[key] && typeof params[key] === "string") &&
        (params.identityServerUrl === undefined || typeof params.identityServerUrl === "string") &&
        !!params.delegatedAuthConfig
    ) {
        return params as StoredAuthorizationParams;
    }
    throw new Error(OidcClientError.StoredParamsNotFound);
};

const retrieveAuthorizationParams = (state: string): StoredAuthorizationParams => {
    const nonce = window.sessionStorage.getItem(`oidc_${state}_nonce`);
    const redirectUri = window.sessionStorage.getItem(`oidc_${state}_redirectUri`);
    const codeVerifier = window.sessionStorage.getItem(`oidc_${state}_codeVerifier`);
    const clientId = window.sessionStorage.getItem(`oidc_${state}_clientId`);
    const homeserverUrl = window.sessionStorage.getItem(`oidc_${state}_homeserverUrl`);
    const identityServerUrl = window.sessionStorage.getItem(`oidc_${state}_identityServerUrl`) ?? undefined;
    const delegatedAuthConfig = window.sessionStorage.getItem(`oidc_${state}_delegatedAuthConfig`);

    return validateStoredAuthorizationParams({
        nonce,
        redirectUri,
        codeVerifier,
        clientId,
        homeserverUrl,
        identityServerUrl,
        delegatedAuthConfig: delegatedAuthConfig ? JSON.parse(delegatedAuthConfig) : undefined,
    });
};

/**
 * Start OIDC authorization code flow
 * Generates auth params, stores them in session storage and
 * Navigates to configured authorization endpoint
 * @param delegatedAuthConfig from discovery
 * @param clientId this client's id as registered with configured issuer
 * @param homeserver target homeserver
 * @returns Promise that resolves after we have navigated to auth endpoint
 */
export const startOidcLogin = async (
    delegatedAuthConfig: ValidatedDelegatedAuthConfig,
    clientId: string,
    homeserverUrl: string,
    identityServerUrl?: string,
): Promise<void> => {
    const redirectUri = window.location.origin;
    const authParams = generateAuthorizationParams({ redirectUri });

    storeAuthorizationParams(authParams, delegatedAuthConfig, clientId, homeserverUrl, identityServerUrl);

    const authorizationUrl = await generateAuthorizationUrl(
        delegatedAuthConfig.authorizationEndpoint,
        clientId,
        authParams,
    );

    window.location.href = authorizationUrl;
};

/**
 * Gets `code` and `state` query params
 *
 * @param queryParams
 * @returns code and state
 * @throws when code and state are not valid strings
 */
const getCodeAndStateFromQueryParams = (queryParams: QueryDict): { code: string; state: string } => {
    const code = queryParams["code"];
    const state = queryParams["state"];

    if (!code || typeof code !== "string" || !state || typeof state !== "string") {
        throw new Error(OidcClientError.InvalidQueryParameters);
    }
    return { code, state };
};

/**
 * Attempt to complete authorization code flow to get an access token
 * @param queryParams the query-parameters extracted from the real query-string of the starting URI.
 * @returns Promise that resolves with accessToken, identityServerUrl, and homeserverUrl when login was successful
 * @throws When we failed to get a valid access token
 */
export const completeOidcLogin = async (
    queryParams: QueryDict,
): Promise<{
    homeserverUrl: string;
    identityServerUrl?: string;
    accessToken: string;
}> => {
    const { code, state } = getCodeAndStateFromQueryParams(queryParams);

    const storedAuthorizationParams = retrieveAuthorizationParams(state);

    const bearerTokenResponse = await completeAuthorizationCodeGrant(code, storedAuthorizationParams);
    // @TODO(kerrya) do something with the refresh token https://github.com/vector-im/element-web/issues/25444
    return {
        homeserverUrl: storedAuthorizationParams.homeserverUrl,
        identityServerUrl: storedAuthorizationParams.identityServerUrl,
        accessToken: bearerTokenResponse.access_token,
    };
};

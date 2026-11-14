import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";
import { HTTP_BACKEND } from "../../config";

type RetriableConfig = InternalAxiosRequestConfig & {
  _retry?: boolean;
};

const SKIP_REFRESH_PATHS = [
  "/auth/signin",
  "/auth/signup",
  "/auth/refresh-token",
  "/auth/logout",
];
const AUTH_DEBUG = process.env.NEXT_PUBLIC_AUTH_DEBUG === "true";

const apiClient = axios.create({
  withCredentials: true,
  // Do not leave auth requests hanging indefinitely when the API DNS,
  // reverse proxy, or deployment is unavailable.
  timeout: 10000,
});

let refreshPromise: Promise<void> | null = null;

async function refreshAccessToken(): Promise<void> {
  if (AUTH_DEBUG) {
    console.info("[auth-debug] attempting access token refresh");
  }

  await axios.post(
    `${HTTP_BACKEND}/auth/refresh-token`,
    {},
    {
      withCredentials: true,
    },
  );

  if (AUTH_DEBUG) {
    console.info("[auth-debug] refresh endpoint responded successfully");
  }
}

function shouldSkipRefresh(config: RetriableConfig): boolean {
  const requestUrl = String(config.url ?? "");
  return SKIP_REFRESH_PATHS.some((path) => requestUrl.includes(path));
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalConfig = error.config as RetriableConfig | undefined;
    const requestUrl = String(originalConfig?.url ?? "unknown-url");

    if (
      !originalConfig ||
      error.response?.status !== 401 ||
      originalConfig._retry ||
      shouldSkipRefresh(originalConfig)
    ) {
      if (AUTH_DEBUG && error.response?.status === 401) {
        console.info("[auth-debug] skipping refresh flow", {
          requestUrl,
          retried: Boolean(originalConfig?._retry),
        });
      }
      throw error;
    }

    originalConfig._retry = true;

    if (AUTH_DEBUG) {
      console.info("[auth-debug] received 401, starting refresh flow", {
        requestUrl,
      });
    }

    if (!refreshPromise) {
      refreshPromise = refreshAccessToken().finally(() => {
        refreshPromise = null;
      });
    }

    try {
      await refreshPromise;
    } catch {
      if (AUTH_DEBUG) {
        console.warn("[auth-debug] refresh flow failed", { requestUrl });
      }
      throw error;
    }

    if (AUTH_DEBUG) {
      console.info("[auth-debug] retrying request after refresh", {
        requestUrl,
      });
    }

    return apiClient(originalConfig);
  },
);

export { apiClient };

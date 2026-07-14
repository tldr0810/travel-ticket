interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    }

    return env.ASSETS.fetch(request);
  },
};

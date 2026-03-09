import type { Env } from './types';

type RouteHandler = (request: Request, env: Env, params: URLSearchParams) => Promise<Response>;

interface Route {
    method: string;
    pattern: string;
    handler: RouteHandler;
}

/**
 * Simple router for Cloudflare Workers.
 * Matches routes by method + pathname prefix.
 */
export class Router {
    private routes: Route[] = [];

    get(pattern: string, handler: RouteHandler) {
        this.routes.push({ method: 'GET', pattern, handler });
        return this;
    }

    post(pattern: string, handler: RouteHandler) {
        this.routes.push({ method: 'POST', pattern, handler });
        return this;
    }

    put(pattern: string, handler: RouteHandler) {
        this.routes.push({ method: 'PUT', pattern, handler });
        return this;
    }

    delete(pattern: string, handler: RouteHandler) {
        this.routes.push({ method: 'DELETE', pattern, handler });
        return this;
    }

    async handle(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const method = request.method;
        const pathname = url.pathname;

        // CORS preflight
        if (method === 'OPTIONS') {
            return corsResponse();
        }

        for (const route of this.routes) {
            if (route.method === method && pathname === route.pattern) {
                try {
                    const response = await route.handler(request, env, url.searchParams);
                    return addCorsHeaders(response);
                } catch (error) {
                    console.error(`Error in ${method} ${pathname}:`, error);
                    const message = error instanceof Error ? error.message : 'Internal server error';
                    return addCorsHeaders(jsonResponse({ success: false, error: message }, 500));
                }
            }
        }

        return addCorsHeaders(jsonResponse({ success: false, error: 'Not found' }, 404));
    }
}

// ─── Response Helpers ───────────────────────────────────────

export function jsonResponse(data: unknown, status: number = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

export function htmlResponse(html: string, status: number = 200): Response {
    return new Response(html, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

function corsResponse(): Response {
    return new Response(null, {
        status: 204,
        headers: corsHeaders(),
    });
}

function addCorsHeaders(response: Response): Response {
    const newResponse = new Response(response.body, response);
    for (const [key, value] of Object.entries(corsHeaders())) {
        newResponse.headers.set(key, value);
    }
    return newResponse;
}

function corsHeaders(): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-PUBLIC-KEY, X-SECRET-KEY',
        'Access-Control-Max-Age': '86400',
    };
}

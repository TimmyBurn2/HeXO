import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** Wraps a component tree in a throwaway QueryClient, for tests. */
export function WithQueryClient({ children }: Readonly<{ children: ReactNode }>) {
    return (
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            {children}
        </QueryClientProvider>
    );
}

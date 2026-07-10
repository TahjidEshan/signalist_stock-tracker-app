import { betterAuth } from "better-auth";
import { mongodbAdapter} from "better-auth/adapters/mongodb";
import { connectToDatabase} from "@/database/mongoose";
import { nextCookies} from "better-auth/next-js";

let authInstance: ReturnType<typeof betterAuth> | null = null;

export const getAuth = async () => {
    if(authInstance) return authInstance;

    const mongoose = await connectToDatabase();
    const db = mongoose.connection.db;

    if(!db) throw new Error('MongoDB connection not found');

    authInstance = betterAuth({
        database: mongodbAdapter(db as any),
        secret: process.env.BETTER_AUTH_SECRET,
        baseURL: process.env.BETTER_AUTH_URL,
        emailAndPassword: {
            enabled: true,
            disableSignUp: false,
            requireEmailVerification: false,
            minPasswordLength: 8,
            maxPasswordLength: 128,
            autoSignIn: true,
        },
        plugins: [nextCookies()],
    });

    return authInstance;
}

// Lazy proxy: importing `auth` must NOT connect to MongoDB (that would force a
// DB during `next build` page-data collection / Docker image builds). The
// connection is deferred to first use at request time instead.
//
// All call sites use the two-level form `auth.<group>.<method>(...args)`
// (e.g. auth.api.getSession(...)). This proxy resolves the real instance on the
// terminal call and forwards, so those sites work unchanged.
type AuthInstance = Awaited<ReturnType<typeof getAuth>>;

export const auth = new Proxy({} as AuthInstance, {
    get(_target, group: string | symbol) {
        return new Proxy({} as Record<string | symbol, any>, {
            get(_t, method: string | symbol) {
                return async (...args: unknown[]) => {
                    const instance = await getAuth();
                    return (instance as Record<string | symbol, any>)[group][method](...args);
                };
            },
        });
    },
});

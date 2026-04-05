"use strict";

const { createClient } = require("@supabase/supabase-js");

/**
 * ENCAPSULATION: Supabase URL, service role key, and client options are created in one place.
 * ABSTRACTION: Callers ask for "the Supabase client", not for raw `createClient` details.
 */
class SupabaseClientProvider {
    /**
     * @returns {import('@supabase/supabase-js').SupabaseClient}
     */
    static create() {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !supabaseRoleKey) {
            throw new Error("Missing supabase url or supabase role key");
        }

        return createClient(supabaseUrl, supabaseRoleKey, {
            auth: { persistSession: false },
        });
    }
}

module.exports = { SupabaseClientProvider };

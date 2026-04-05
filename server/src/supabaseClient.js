"use strict";

/**
 * Thin re-export: keeps the original `require("./supabaseClient")` path working.
 * Implementation: `SupabaseClientProvider` (factory / encapsulation of env + createClient).
 */

const { SupabaseClientProvider } = require("./supabase/SupabaseClientProvider");

function getSupabase() {
    return SupabaseClientProvider.create();
}

module.exports = { getSupabase };

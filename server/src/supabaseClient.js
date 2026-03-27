"use strict";

const { createClient } = require("@supabase/supabase-js");

function getSupabase() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseRoleKey) {
        throw new Error("Missing supabase url or supabase role key");
    }

    return createClient(supabaseUrl, supabaseRoleKey, {
        auth: { persistSession: false },
    });
}

module.exports = { getSupabase };
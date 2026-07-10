import { Inngest} from "inngest";

// AI now runs locally via Ollama (see lib/ollama). Inngest's built-in AI
// providers are no longer used, so no provider config is needed here.
export const inngest = new Inngest({
    id: 'signalist',
})

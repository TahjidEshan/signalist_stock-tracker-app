declare global {
    type SignInFormData = {
        email: string;
        password: string;
    };

    type SignUpFormData = {
        fullName: string;
        email: string;
        password: string;
        country: string;
        investmentGoals: string;
        riskTolerance: string;
        preferredIndustry: string;
    };

    type CountrySelectProps = {
        name: string;
        label: string;
        control: Control;
        error?: FieldError;
        required?: boolean;
    };

    type FormInputProps = {
        name: string;
        label: string;
        placeholder: string;
        type?: string;
        register: UseFormRegister;
        error?: FieldError;
        validation?: RegisterOptions;
        disabled?: boolean;
        value?: string;
    };

    type Option = {
        value: string;
        label: string;
    };

    type SelectFieldProps = {
        name: string;
        label: string;
        placeholder: string;
        options: readonly Option[];
        control: Control;
        error?: FieldError;
        required?: boolean;
    };

    type FooterLinkProps = {
        text: string;
        linkText: string;
        href: string;
    };

    type SearchCommandProps = {
        renderAs?: 'button' | 'text';
        label?: string;
        initialStocks: StockWithWatchlistStatus[];
    };

    type WelcomeEmailData = {
        email: string;
        name: string;
        intro: string;
    };

    type UserForNewsEmail = {
        id: string;
        email: string;
        name: string;
    };

    type User = {
        id: string;
        name: string;
        email: string;
    };

    type Stock = {
        symbol: string;
        name: string;
        exchange: string;
        type: string;
    };

    type StockWithWatchlistStatus = Stock & {
        isInWatchlist: boolean;
    };

    type FinnhubSearchResult = {
        symbol: string;
        description: string;
        displaySymbol?: string;
        type: string;
    };

    type FinnhubSearchResponse = {
        count: number;
        result: FinnhubSearchResult[];
    };

    type StockDetailsPageProps = {
        params: Promise<{
            symbol: string;
        }>;
    };

    type WatchlistButtonProps = {
        symbol: string;
        company: string;
        isInWatchlist: boolean;
        showTrashIcon?: boolean;
        type?: 'button' | 'icon';
        onWatchlistChange?: (symbol: string, isAdded: boolean) => void;
    };

    type QuoteData = {
        c?: number;
        dp?: number;
    };

    type ProfileData = {
        name?: string;
        marketCapitalization?: number;
    };

    type FinancialsData = {
        metric?: { [key: string]: number };
    };

    type SelectedStock = {
        symbol: string;
        company: string;
        currentPrice?: number;
    };

    type WatchlistTableProps = {
        watchlist: StockWithData[];
    };

    type StockWithData = {
        userId: string;
        symbol: string;
        company: string;
        addedAt: Date;
        currentPrice?: number;
        changePercent?: number;
        priceFormatted?: string;
        changeFormatted?: string;
        marketCap?: string;
        peRatio?: string;
    };

    type AlertsListProps = {
        alertData: Alert[] | undefined;
    };

    type MarketNewsArticle = {
        id: number;
        headline: string;
        summary: string;
        source: string;
        url: string;
        datetime: number;
        category: string;
        related: string;
        image?: string;
    };

    type WatchlistNewsProps = {
        news?: MarketNewsArticle[];
    };

    type SearchCommandProps = {
        open?: boolean;
        setOpen?: (open: boolean) => void;
        renderAs?: 'button' | 'text';
        buttonLabel?: string;
        buttonVariant?: 'primary' | 'secondary';
        className?: string;
    };

    type AlertData = {
        symbol: string;
        company: string;
        alertName: string;
        alertType: 'upper' | 'lower';
        threshold: string;
    };

    type AlertModalProps = {
        alertId?: string;
        alertData?: AlertData;
        action?: string;
        open: boolean;
        setOpen: (open: boolean) => void;
    };

    type RawNewsArticle = {
        id: number;
        headline?: string;
        summary?: string;
        source?: string;
        url?: string;
        datetime?: number;
        image?: string;
        category?: string;
        related?: string;
    };

    type Alert = {
        id: string;
        symbol: string;
        company: string;
        alertName: string;
        currentPrice: number;
        alertType: 'upper' | 'lower';
        threshold: number;
        changePercent?: number;
    };

    // ---- Signal-scanning pipeline ----

    // Text-bearing sources whose ticker mentions get counted + LLM-summarized.
    type MentionSource = 'reddit' | 'reddit-comment' | 'stocktwits' | 'twitter' | 'news';

    type ScrapedMention = {
        symbol: string;
        source: MentionSource;
        // Free-text snippet (post title / message body / headline) for LLM context.
        text: string;
        // Original permalink if available.
        url?: string;
        // Bullish / bearish tag when the source provides one (StockTwits does).
        sentiment?: 'bullish' | 'bearish' | null;
        createdAt?: number;
    };

    type MentionAggregate = {
        symbol: string;
        mentions: number;
        sources: MentionSource[];
        bullish: number;
        bearish: number;
        samples: string[]; // a few representative snippets
        // How many mentions are recent (within the velocity window) — used to
        // detect sudden acceleration rather than raw volume.
        recentMentions: number;
    };

    type MoverSignal = {
        symbol: string;
        price: number;
        changePercent: number;
        direction: 'up' | 'down';
        // Volume spike: today's volume vs. its recent average (e.g. 3.2 = 3.2x).
        volumeRatio?: number | null;
    };

    // A per-symbol insider / material-event signal from SEC EDGAR.
    type InsiderSignal = {
        symbol: string;
        // 'insider-buy' (Form 4 acquisition), 'insider-sell', or '8-K' event.
        kind: 'insider-buy' | 'insider-sell' | '8-K';
        title: string;
        url?: string;
        filedAt?: number;
    };

    // All signal sources that can contribute to a candidate's `sources` list.
    type SignalSourceTag = MentionSource | 'movers' | 'volume' | 'insider' | 'filing';

    type CandidateSignal = {
        symbol: string;
        mentions: number;
        recentMentions: number;
        sources: SignalSourceTag[];
        bullish: number;
        bearish: number;
        changePercent: number | null;
        volumeRatio: number | null;
        // Human-readable catalysts (news headlines, insider buys) for LLM context.
        catalysts: string[];
        direction: 'up' | 'down' | 'neutral';
        score: number;
        samples: string[];
    };
}

export {};

/*!
 * Prayer Dome — Team member record model
 * ---------------------------------------------------------------------------
 * One place that knows what a team member *is*. Both the public /team page and
 * the admin console use it, so a record written by the console is rendered the
 * same way everywhere, and records that were saved by the older console keep
 * working without a manual migration.
 *
 * Two Firestore collections are used, on purpose:
 *
 *   teamMembers/{id}         Public, published profiles only. Readable by
 *                            visitors; writable by administrators. Contains no
 *                            private contact details.
 *   teamMemberContacts/{id}  Private email + phone, same document id. Readable
 *                            and writable by administrators only.
 *
 * Splitting the private half out is what makes "email visible on the public
 * profile" a real privacy control instead of a CSS class: a visitor's client
 * never receives the address unless the administrator approved it.
 *
 * The module is dependency-free and works offline. Nothing here fabricates a
 * contact detail: an absent email stays absent.
 */
(function (global) {
    'use strict';

    var STATUSES = {
        active: {
            label: 'Active',
            short: 'Serving',
            description: 'Currently serving on the team.',
            icon: 'pd-i-user-check',
            tone: 'active'
        },
        inactive: {
            label: 'Inactive',
            short: 'Inactive',
            description: 'Still part of the team, but not serving at the moment.',
            icon: 'pd-i-user',
            tone: 'muted'
        },
        deceased: {
            label: 'Deceased',
            short: 'In loving memory',
            description: 'Went home to the Lord. Their record is preserved and never removed automatically.',
            icon: 'pd-i-heart',
            tone: 'memorial'
        },
        former: {
            label: 'Former member',
            short: 'Former',
            description: 'Served with Prayer Dome in the past. The history stays on file.',
            icon: 'pd-i-archive',
            tone: 'muted'
        }
    };

    var STATUS_ORDER = ['active', 'inactive', 'deceased', 'former'];

    // The built-in roster predates the department field, so it is derived from
    // the area a person was already listed under. Nothing is invented about a
    // person beyond the grouping the ministry already used.
    var CATEGORY_DEPARTMENTS = {
        founder: 'Leadership',
        eswatini: 'Pastoral Ministry',
        zambia: 'Pastoral Ministry',
        worship: 'Worship & Music',
        ministries: 'Ministries & Prayer Centres'
    };

    var CATEGORY_LABELS = {
        founder: 'Founder',
        eswatini: 'Eswatini',
        zambia: 'Zambia',
        worship: 'Worship',
        ministries: 'Ministries'
    };

    function str(value) {
        return value == null ? '' : String(value).trim();
    }

    function bool(value, fallback) {
        if (value === true || value === 'true' || value === 1 || value === '1') return true;
        if (value === false || value === 'false' || value === 0 || value === '0') return false;
        return fallback;
    }

    function numberOf(value, fallback) {
        var parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    /** Canonical status, translating the legacy archived/deceased booleans. */
    function statusOf(raw) {
        if (!raw) return 'active';
        var status = str(raw.status).toLowerCase();
        if (STATUSES[status]) return status;
        if (bool(raw.deceased, false)) return 'deceased';
        if (bool(raw.archived, false)) return 'former';
        return 'active';
    }

    function categoryOf(raw) {
        var category = str(raw && raw.category).toLowerCase();
        return CATEGORY_LABELS[category] ? category : 'eswatini';
    }

    /**
     * Merge a public document and its private contact document into the shape
     * the UI uses.
     *
     * `email` is deliberately the *public* address, and is empty unless the
     * administrator ticked "show this email on the public profile". The private
     * address lives on `privateEmail` and is only ever loaded for an admin.
     */
    function normalize(raw, contact, options) {
        raw = raw || {};
        contact = contact || {};
        options = options || {};
        var status = statusOf(raw);
        var category = categoryOf(raw);
        var emailPublic = bool(raw.emailPublic, false);
        var publicEmail = emailPublic ? str(raw.publicEmail || raw.publicEmailAddress) : '';
        var privateEmail = str(contact.email || raw.email || raw.privateEmail || contact.publicEmail);
        var privatePhone = str(contact.phone || raw.phone || contact.privatePhone);

        var record = {
            id: str(raw.id || options.id),
            schemaVersion: numberOf(raw.schemaVersion, 1),
            name: str(raw.name || raw.fullName),
            title: str(raw.title || raw.position),
            role: str(raw.role),
            department: str(raw.department) || CATEGORY_DEPARTMENTS[category] || 'Ministry',
            category: category,
            categoryLabel: CATEGORY_LABELS[category],
            country: str(raw.country || raw.region),
            image: str(raw.image || raw.photo || raw.imageUrl),
            description: str(raw.description || raw.bio || raw.biography),
            responsibilities: str(raw.responsibilities || raw.duties),
            scripture: str(raw.scripture),
            dateJoined: str(raw.dateJoined || raw.joinedAt),
            status: status,
            statusLabel: STATUSES[status].label,
            published: bool(raw.published, true),
            showInMemorial: bool(raw.showInMemorial, true),
            // Lower numbers are shown first. `order` is kept as an alias for
            // older documents and older links.
            priority: numberOf(raw.priority, numberOf(raw.order, 999)),
            passedAt: status === 'deceased' ? str(raw.passedAt || raw.dateOfPassing) : '',
            lateLabel: str(raw.lateLabel) || 'Late',
            memorialMessage: str(raw.memorialMessage || raw.memorialNote),
            emailPublic: emailPublic,
            // Public email only. Private addresses never travel on this field.
            email: publicEmail,
            publicEmail: publicEmail,
            privateEmail: privateEmail,
            privatePhone: privatePhone,
            // `archived` is the legacy "hidden" flag. Status is the source of
            // truth now; a published former member is allowed to appear.
            archived: bool(raw.archived, false),
            deceased: status === 'deceased',
            createdAt: raw.createdAt || null,
            updatedAt: raw.updatedAt || null,
            source: options.source || 'firestore'
        };

        record.initials = initials(record.name);
        record.displayTitle = record.title || record.role || 'Prayer Dome Team';
        record.isMemorial = record.status === 'deceased';
        return record;
    }

    function initials(name) {
        return str(name || '?').split(/\s+/).slice(0, 2)
            .map(function (part) { return part.charAt(0).toUpperCase(); }).join('') || '?';
    }

    /**
     * The document that is safe to expose to the public. Never add private
     * contact fields here — they belong in `toContactDoc`.
     */
    function toPublicDoc(record) {
        record = record || {};
        var category = categoryOf(record);
        var status = statusOf(record);
        var data = {
            schemaVersion: 2,
            name: str(record.name),
            title: str(record.title),
            role: str(record.role),
            department: str(record.department) || CATEGORY_DEPARTMENTS[category] || '',
            category: category,
            country: str(record.country),
            image: str(record.image),
            description: str(record.description),
            responsibilities: str(record.responsibilities),
            scripture: str(record.scripture),
            dateJoined: str(record.dateJoined),
            status: status,
            published: bool(record.published, true),
            showInMemorial: bool(record.showInMemorial, true),
            priority: numberOf(record.priority, 999),
            order: numberOf(record.priority, 999),
            emailPublic: bool(record.emailPublic, false) && !!str(record.publicEmail),
            publicEmail: bool(record.emailPublic, false) ? str(record.publicEmail) : '',
            // `archived` is the legacy hidden flag. Status replaced it, so a
            // current record always clears it; otherwise an old archived flag
            // would keep hiding a member the administrator reactivated.
            archived: false,
            deceased: status === 'deceased',
            lateLabel: status === 'deceased' ? (str(record.lateLabel) || 'Late') : '',
            passedAt: status === 'deceased' ? str(record.passedAt) : '',
            memorialMessage: status === 'deceased' ? str(record.memorialMessage) : ''
        };
        return data;
    }

    /** The private half of the record. Administrator-only in the rules. */
    function toContactDoc(record) {
        record = record || {};
        return {
            memberId: str(record.id),
            email: str(record.privateEmail),
            phone: str(record.privatePhone),
            emailPublic: bool(record.emailPublic, false),
            publicEmail: bool(record.emailPublic, false) ? str(record.publicEmail) : ''
        };
    }

    /** Validation shared by both editors. Never returns invented data. */
    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    function validate(record) {
        record = record || {};
        var errors = [];
        var name = str(record.name);
        if (!name) errors.push('Enter the member’s full name.');
        if (name.length > 80) errors.push('The name must be 80 characters or fewer.');
        if (str(record.title).length > 100) errors.push('The position must be 100 characters or fewer.');
        if (str(record.department).length > 80) errors.push('The department must be 80 characters or fewer.');
        if (str(record.description).length > 600) errors.push('The biography must be 600 characters or fewer.');
        if (str(record.responsibilities).length > 600) errors.push('Responsibilities must be 600 characters or fewer.');
        var email = str(record.privateEmail);
        if (email && !EMAIL_RE.test(email)) errors.push('Enter a valid email address, or leave the field empty.');
        if (!STATUSES[statusOf(record)]) errors.push('Choose a valid member status.');
        var priority = numberOf(record.priority, NaN);
        if (!Number.isFinite(priority)) errors.push('Display priority must be a number.');
        return { ok: errors.length === 0, errors: errors };
    }

    /** Sort: priority first, then name. Stable for equal priorities. */
    function sort(members) {
        return (members || []).slice().sort(function (a, b) {
            return numberOf(a.priority, 999) - numberOf(b.priority, 999) ||
                String(a.name || '').localeCompare(String(b.name || ''));
        });
    }

    function publicMembers(members) {
        return sort((members || []).filter(function (m) { return m.published !== false; }));
    }

    function memorialMembers(members) {
        return sort((members || []).filter(function (m) {
            return m.status === 'deceased' && m.published !== false && m.showInMemorial !== false;
        }));
    }

    function statusLabel(status) {
        return (STATUSES[str(status)] || STATUSES.active).label;
    }

    function statusMeta(status) {
        return STATUSES[str(status)] || STATUSES.active;
    }

    function formatDate(value) {
        if (!value) return '';
        // Firestore Timestamp objects (and the compat SDK's Timestamps) expose
        // toDate(); plain strings from a date input go straight to Date.
        var date = value instanceof Date
            ? value
            : (value && typeof value.toDate === 'function' ? value.toDate() : new Date(value));
        if (isNaN(date.getTime())) return str(value);
        return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    }

    global.PDTeam = {
        STATUSES: STATUSES,
        STATUS_ORDER: STATUS_ORDER,
        CATEGORY_LABELS: CATEGORY_LABELS,
        CATEGORY_DEPARTMENTS: CATEGORY_DEPARTMENTS,
        EMAIL_RE: EMAIL_RE,
        normalize: normalize,
        statusOf: statusOf,
        toPublicDoc: toPublicDoc,
        toContactDoc: toContactDoc,
        validate: validate,
        sort: sort,
        publicMembers: publicMembers,
        memorialMembers: memorialMembers,
        statusLabel: statusLabel,
        statusMeta: statusMeta,
        initials: initials,
        formatDate: formatDate
    };
})(typeof window !== 'undefined' ? window : globalThis);

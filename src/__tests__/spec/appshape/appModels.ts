import {
  belongsTo,
  createSingletonStatics,
  defineModel,
  defineShape,
  f,
  hasMany,
  hasOne,
  projectShape,
  references
} from '../../legacyTestApi';

const mediaSchema = defineShape()({
  id: f.id(),
  kind: f.str(),
  fileUrl: f.str(),
  thumbUrl: f.str().from((media: any) => media.thumbUrl || null).nullable(),
  coverUrl: f.str().nullDefault(),
  gifUrl: f.str().nullDefault(),
  blurHash: f.str().nullDefault(),
  duration: f.num().nullDefault(),
  width: f.num().nullDefault(),
  height: f.num().nullDefault(),
  transcoded: f.custom<boolean, any>(media => media.transcoded === true),
  transcodeStatus: f.str().nullDefault(),
  transcodeProgress: f.num().nullDefault(),
  transcodeError: f.str().nullDefault()
});

const attachedUserSchema = defineShape()({
  id: f.id(),
  fullName: f.str(),
  username: f.str(),
  avatarUrl: f.str().nullDefault()
});

const reactionSchema = defineShape()({
  id: f.id(),
  body: f.str(),
  userId: f.id(),
  createdAt: f.str(),
  updatedAt: f.str(),
  user: f.object(attachedUserSchema).nullable()
});

const readMarksSchema = defineShape()({
  total: f.num(),
  read: f.num(),
  unread: f.num(),
  readByCurrentUser: f.bool(),
  memberReadStatus: f.array(
    defineShape()({
      userId: f.id(),
      readAt: f.str().nullable()
    })
  ).from((value: any) => value.memberReadStatus ?? [])
});

const summarySchema = defineShape()({
  body: f.str(),
  languageCode: f.str().nullable(),
  generatedAt: f.str()
});

const replySchema = defineShape()({
  id: f.id(),
  body: f.str().nullDefault(),
  kind: f.str().optional(),
  createdAt: f.str(),
  status: f.str(),
  userId: f.id().nullable(),
  chatId: f.id(),
  replyToId: f.id().nullable(),
  oneTime: f.bool(),
  isSystem: f.bool(),
  forwardedFromUserId: f.id().nullable(),
  user: f.object(attachedUserSchema).nullable(),
  media: f.object(mediaSchema).nullable()
});

const attachedMomentSchema = defineShape()({
  id: f.id(),
  uuid: f.str(),
  userId: f.id().nullable(),
  kind: f.str(),
  contentKind: f.str(),
  user: f.object(defineShape()({ id: f.id(), fullName: f.str(), username: f.str(), avatarUrl: f.str().nullDefault() })).nullable(),
  media: f.object(mediaSchema)
});

const metricsSchema = defineShape()({
  description: f.str().nullDefault(),
  qualityScore: f.num().nullDefault(),
  qualityScoreReason: f.str().nullDefault(),
  aiScore: f.num().nullDefault(),
  aiScoreReason: f.str().nullDefault(),
  contentRating: f.str().nullDefault(),
  contentRatingReason: f.str().nullDefault(),
  analyzeStatus: f.str().nullDefault(),
  analyzedAt: f.str().nullDefault(),
  keywords: f.array(f.str()).from((value: any) => value.keywords ?? []).default(() => []),
  objects: f.array(f.str()).from((value: any) => value.objects ?? []).default(() => []),
  scenes: f.array(f.str()).from((value: any) => value.scenes ?? []).default(() => []),
  moods: f.array(f.str()).from((value: any) => value.moods ?? []).default(() => []),
  genders: f.array(f.str()).from((value: any) => value.genders ?? []).default(() => []),
  compatibilityIndicators: f.array(f.str()).from((value: any) => value.compatibilityIndicators ?? []).default(() => []),
  styleLifestyles: f.array(f.str()).from((value: any) => value.styleLifestyles ?? []).default(() => []),
  colors: f.array(f.str()).from((value: any) => value.colors ?? []).default(() => [])
});

const compareMessagesNewest = (left: any, right: any): number => {
  const leftSequence = left.sequenceNumber;
  const rightSequence = right.sequenceNumber;
  if (typeof leftSequence === 'number' && typeof rightSequence === 'number' && leftSequence !== rightSequence) return rightSequence - leftSequence;
  if (left.createdAt !== right.createdAt) return String(right.createdAt).localeCompare(String(left.createdAt));
  if (typeof leftSequence === 'number' && typeof rightSequence !== 'number') return -1;
  if (typeof leftSequence !== 'number' && typeof rightSequence === 'number') return 1;
  return String(right.id).localeCompare(String(left.id));
};

const compareCompassMoments = (left: any, right: any): number => {
  const unread = Number(right.unreadSimilarMomentsCount ?? 0) - Number(left.unreadSimilarMomentsCount ?? 0);
  return unread !== 0 ? unread : String(right.createdAt).localeCompare(String(left.createdAt));
};

const mediaBucketOf = (message: any): string | null => {
  const kind = message.media?.kind;
  if (kind === 'photo' || kind === 'video' || kind === 'gif') return 'visual';
  if (kind === 'audio') return 'audio';
  if (kind === 'gift') return 'gifts';
  return null;
};

export const createAppModels = (tag: string) => {
  const users = defineModel({
    id: `AppShapeUser:${tag}`,
    name: `AppShapeUser:${tag}`,
    fields: {
      uuid: f.str().optional(), fullName: f.str(), username: f.str(), name: f.str().nullable().optional(), avatarUrl: f.str().nullable(),
      fullAvatarUrl: f.str().nullable().optional(), age: f.num().nullable().optional(), gender: f.enum(['male', 'female', 'other'] as const).nullable().optional(),
      description: f.str().nullable().optional(), story: f.str().nullable().optional(), connectionStatus: f.enum(['none', 'pending', 'connected'] as const).nullable(),
      connectionChatId: f.id().nullable().optional(), lastInteraction: f.enum(['none', 'liked', 'passed'] as const).nullable(), online: f.bool(), lastSeenAt: f.str().nullable(),
      distance: f.num().nullable().optional(), shareUrl: f.str().optional(), countryName: f.custom<string | null, any>(input => input.countryName !== undefined ? input.countryName : input.country?.name).nullable().optional(),
      countryCode: f.custom<string | null, any>(input => input.countryCode !== undefined ? input.countryCode : input.country?.code).nullable().optional(), createdAt: f.str(), updatedAt: f.str(),
      isFriend: f.bool().optional(), isBlocked: f.bool().optional()
    },
    scopes: {
      blocked: ({ by: { isBlocked: 'isBlocked' }, sort: { field: 'fullName', dir: 'asc' } }),
      friends: ({ by: { isFriend: 'isFriend' }, sort: { field: 'fullName', dir: 'asc' } }),
      byUuid: ({ by: { uuid: 'uuid' } }),
      visitors: ({ sort: 'server-order' })
    },
    statics: () => ({ toAttachedSnapshot: (user: any) => projectShape(attachedUserSchema, user) })
  });

  const currentUser = defineModel({
    id: `AppShapeCurrentUser:${tag}`,
    name: `AppShapeCurrentUser:${tag}`,
    gc: 'exempt',
    fields: {
      uuid: f.str(), fullName: f.str(), username: f.str(), name: f.str().nullable(), avatarUrl: f.str().nullable(), fullAvatarUrl: f.str().nullable(), age: f.num().nullable(),
      gender: f.enum(['male', 'female', 'other'] as const).nullable(), description: f.str().nullable(), story: f.str().nullable(), connectionStatus: f.enum(['none', 'pending', 'connected'] as const).nullable(),
      connectionChatId: f.id().nullable(), lastInteraction: f.enum(['none', 'liked', 'passed'] as const).nullable(), online: f.bool(), lastSeenAt: f.str().nullable(), distance: f.num().nullable(),
      shareUrl: f.str(), countryName: f.custom<string | null, any>(input => input.countryName !== undefined ? input.countryName : input.country?.name).nullable(),
      countryCode: f.custom<string | null, any>(input => input.countryCode !== undefined ? input.countryCode : input.country?.code).nullable(), createdAt: f.str(), updatedAt: f.str(),
      email: f.str().nullable(), phone: f.str().nullable(), registrationCompleted: f.bool(), balance: f.num(), premiumGrant: f.raw<any>().nullable(),
      dob: f.str().nullable(), locationCity: f.custom<string | null, any>(input => input.locationCity ?? input.location?.city).nullable(), locationName: f.custom<string | null, any>(input => input.locationName ?? input.location?.name).nullable(),
      locationLat: f.custom<number | null, any>(input => input.locationLat ?? input.location?.lat).nullable(), locationLng: f.custom<number | null, any>(input => input.locationLng ?? input.location?.lng).nullable(),
      filterDistance: f.num().nullable(), filterGender: f.enum(['all', 'male', 'female'] as const), filterMinAge: f.num(), filterMaxAge: f.num(), kind: f.str(), hasCompass: f.bool(), hasMoments: f.bool(),
      hasPhoto: f.bool(), hasGoodPhoto: f.bool(), hasInitialMoment: f.bool(), stickyLocation: f.bool(), status: f.enum(['active', 'blocked'] as const), preferenceNotifyConnection: f.bool(),
      preferenceNotifyMessage: f.bool(), preferenceVibration: f.bool(), receivedGifts: f.raw<any>()
    },
    write: { groups: [{ fields: ['locationCity', 'locationName', 'locationLat', 'locationLng', 'stickyLocation'] as const, policy: { monotonic: { newerBy: 'updatedAt' } } }] },
    statics: model => ({ currentId: () => model.all()[0]?.id })
  });

  const countersDefaults = { id: 'counters', unreadChatsCount: 0, unreadCompassCount: 0, unreadSecondaryChatsCount: 0, secondaryChatsCount: 0, premiumSecondaryChatsCount: 0 };
  const counters = defineModel({
    id: `AppShapeUserCounters:${tag}`,
    name: `AppShapeUserCounters:${tag}`,
    gc: 'exempt',
    fields: { unreadChatsCount: f.num().default(0), unreadCompassCount: f.num().default(0), unreadSecondaryChatsCount: f.num().default(0), secondaryChatsCount: f.num().default(0), premiumSecondaryChatsCount: f.num().default(0) },
    statics: model => createSingletonStatics(model, 'counters', countersDefaults)
  });

  const vibes = defineModel({
    id: `AppShapeVibe:${tag}`,
    name: `AppShapeVibe:${tag}`,
    gc: 'exempt',
    fields: { name: f.str(), description: f.str().nullable(), color: f.str(), position: f.num(), createdAt: f.str(), updatedAt: f.str() },
    scopes: { catalog: ({ sort: { field: 'position', dir: 'asc' } }) }
  });

  const walletTransactions = defineModel({
    id: `AppShapeWalletTransaction:${tag}`,
    name: `AppShapeWalletTransaction:${tag}`,
    fields: {
      amount: f.num(), creditAmount: f.num().nullable(), price: f.num().nullable(), currency: f.str().nullable(), localizedPrice: f.str().nullable(), kind: f.str(), title: f.str().nullable(), subtitle: f.str().nullable(), description: f.str().nullable(),
      gift: f.object(defineShape()({ imageUrl: f.str() })).from((input: any) => input.gift?.imageUrl ? input.gift : null).nullable(), recipient: f.object(attachedUserSchema).from((input: any) => input.recipient ?? null).nullable(), createdAt: f.str(), updatedAt: f.str()
    },
    scopes: { all: ({ sort: { field: 'createdAt', dir: 'desc' } }), byKind: ({ by: { kind: 'kind' }, sort: { field: 'createdAt', dir: 'desc' } }) }
  });

  const messages: any = defineModel({
    id: `AppShapeMessage:${tag}`,
    name: `AppShapeMessage:${tag}`,
    fields: {
      chatId: f.id(), userId: f.custom<string, any>(input => input.user?.id ?? input.userId), body: f.str().nullable(), kind: f.enum(['text', 'photo', 'video', 'audio', 'gift', 'system'] as const),
      status: f.enum(['Sending', 'Failed', 'Sent', 'Read'] as const).default('Sending'), createdAt: f.str(), updatedAt: f.str(), modifiedAt: f.str().nullable(), oneTime: f.bool().default(false), expired: f.bool().default(false),
      expiresAt: f.str().nullable(), isSystem: f.bool().default(false), unread: f.bool().default(false), sequenceNumber: f.num().nullable(), mediaGroupId: f.str().nullable(), replyToId: f.id().nullable(), forwardedFromUserId: f.id().nullable(),
      media: f.object(mediaSchema).from((message: any) => message.media ?? null).nullable(), mediaBucket: f.custom<string | null, any>(mediaBucketOf), mediaUrl: f.str().nullable(), localPreviewUrl: f.str().from((message: any) => message.localPreviewUrl).nullable().optional(),
      location: f.array(defineShape()({ id: f.id(), name: f.str().nullDefault(), address: f.str(), city: f.str().nullDefault(), lat: f.num(), lng: f.num() })).from((message: any) => message.location ?? []).default(() => []), transcribed: f.bool().default(false), transcript: f.str().nullable(),
      reactions: f.array(reactionSchema).from((message: any) => message.reactions ?? []).default(() => []), attachedMoment: f.object(attachedMomentSchema).from((message: any) => message.attachedMoment ?? null).nullable(), attachedGift: f.object(defineShape()({ id: f.id(), kind: f.str(), status: f.str(), gift: f.object(defineShape()({ id: f.id(), title: f.str() })).nullable() })).from((message: any) => message.attachedGift ?? null).nullable(),
      attachedUser: f.object(attachedUserSchema).from((message: any) => message.attachedUser ?? null).nullable(), attachedReaction: f.object(reactionSchema).from((message: any) => message.attachedReaction ?? null).nullable(), replyTo: f.object(replySchema).from((message: any) => message.replyTo ?? null).nullable(), clientId: f.str().from((message: any) => message.clientId).nullDefault(), isDeleted: f.custom<boolean, any>(message => message.isDeleted === true).default(false)
    },
    scopes: {
      thread: ({ by: { chatId: 'chatId' }, sort: { comparator: compareMessagesNewest, orderFields: ['sequenceNumber', 'createdAt'] } }),
      media: ({ by: { chatId: 'chatId', mediaBucket: 'mediaBucket' }, sort: { comparator: compareMessagesNewest, orderFields: ['sequenceNumber', 'createdAt'] } })
    },
    relations: () => ({
      user: belongsTo<any, any>(users, { foreignKey: 'userId' }),
      chat: belongsTo<any, any>(chats, { foreignKey: 'chatId', touch: (message, chat) => compareMessagesNewest(message, { ...chat, id: chat.lastMessageId ?? '', createdAt: chat.lastMessageAt ?? '', sequenceNumber: chat.lastSequenceNumber }) < 0 ? { lastActivityAt: message.createdAt, lastMessageAt: message.createdAt, lastMessageId: message.id, lastSequenceNumber: message.sequenceNumber } : null, counterCache: { field: 'unreadCount', filter: message => message.userId !== currentUser.currentId() } }),
      replyTarget: references<any, any>(messages, { ids: message => message.replyToId })
    }),
    write: {
      groups: [
        { fields: ['media'] as const, policy: [{ monotonic: { all: [{ ladder: { path: 'media.transcodeStatus', tiers: [['processing'], ['ready', 'failed', 'completed']] } }, { tuple: ['media.transcodeProgress'] }] } }, { keys: { width: 'positive', height: 'positive', fileUrl: 'nonEmpty', thumbUrl: 'nonEmpty', coverUrl: 'nonEmpty', gifUrl: 'nonEmpty' } }] },
        { fields: ['localPreviewUrl'] as const, policy: 'continuity' },
        { fields: ['clientId'] as const, policy: { monotonic: { nonEmpty: true } } }
      ]
    },
    maintenance: { dropTempRowsAfterMs: 60_000, maxRowsPerScope: [{ scopeField: 'chatId', limit: 300, compare: compareMessagesNewest, protect: () => { const ids = new Set(chats.all().flatMap((chat: any) => chat.lastMessageId ? [chat.lastMessageId] : [])); return (message: any) => ids.has(message.id); } }] }
  });

  const chats = defineModel({
    id: `AppShapeChat:${tag}`,
    name: `AppShapeChat:${tag}`,
    fields: {
      uuid: f.str().nullable(), kind: f.enum(['personal', 'group', 'system'] as const), status: f.enum(['active', 'archived', 'pending'] as const), premium: f.bool(), name: f.str().nullable(), logoUrl: f.str().nullable(), description: f.str().nullable(), isPublic: f.bool(), history: f.enum(['all', 'members'] as const), pinned: f.bool(), muted: f.bool(), read: f.bool(), unreadCount: f.num().default(0), messagesCount: f.num(), lastActivityAt: f.str(), lastMessageAt: f.str().nullable(), lastSequenceNumber: f.num().nullable().optional(),
      lastMessageId: f.id().from((chat: any) => chat.lastMessage?.id).nullable().optional(), readMarksSummary: f.object(readMarksSchema).from((chat: any) => chat.readMarksSummary).nullable(), summary: f.object(summarySchema).from((chat: any) => chat.summary).nullable(), connectionStatus: f.enum(['none', 'pending', 'connected'] as const).nullable(), userIds: f.custom<string[], any>(chat => chat.userIds ?? chat.users?.map((user: any) => user.id) ?? []), ownerId: f.id().from((chat: any) => chat.owner?.id).nullable().optional(), createdAt: f.str(), updatedAt: f.str()
    },
    scopes: {
      list: ({ by: { statusFilter: 'status' }, sort: { field: 'lastActivityAt', dir: 'desc' } }),
      premium: ({ by: { statusFilter: 'status' }, member: (chat: any) => chat.premium === true && chat.kind !== 'system', sort: { field: 'lastActivityAt', dir: 'desc' } }),
      pinnedNonSystem: ({ by: { statusFilter: 'status' }, member: (chat: any) => chat.pinned === true && chat.kind !== 'system', sort: { field: 'lastActivityAt', dir: 'desc' } }),
      pinnedOrSystem: ({ by: { statusFilter: 'status' }, member: (chat: any) => chat.pinned === true || chat.kind === 'system', sort: { field: 'lastActivityAt', dir: 'desc' } })
    },
    relations: () => ({ messages: hasMany<any, any>(messages, { foreignKey: 'chatId', dependent: 'destroy' }), lastMessage: hasOne<any, any>(messages, { foreignKey: 'chatId', comparator: compareMessagesNewest }), memberUsers: references<any, any>(users, { ids: chat => chat.userIds ?? [] }) }),
    write: { groups: [{ fields: ['lastMessageId', 'lastMessageAt', 'lastSequenceNumber'] as const, policy: { monotonic: { tuple: ['lastSequenceNumber', 'lastMessageAt', 'lastMessageId'] } } }, { fields: ['pinned', 'muted'] as const, policy: { monotonic: { newerBy: 'updatedAt' } } }] }
  });

  const moments = defineModel({
    id: `AppShapeMoment:${tag}`,
    name: `AppShapeMoment:${tag}`,
    fields: {
      uuid: f.str(), userId: f.id().from((moment: any) => moment.user?.id ?? moment.userId).nullable(), kind: f.enum(['basic', 'compass'] as const).default('basic'), status: f.enum(['drafted', 'published'] as const).default('drafted'), contentKind: f.enum(['safe', 'sensitive'] as const).default('safe'), media: f.object(mediaSchema).default(() => ({ id: '', kind: '', fileUrl: '', thumbUrl: null, coverUrl: null, gifUrl: null, blurHash: null, duration: null, width: null, height: null, transcoded: false, transcodeStatus: null, transcodeProgress: null, transcodeError: null })), compassTitle: f.str().default(''), compassUpdatedAt: f.str().nullable(), reacted: f.bool().default(false), shareUrl: f.str().default(''), visitsCount: f.num().nullable(), visitorIds: f.array(f.id()).from((input: any) => input.visitorIds ?? []).default(() => []), unreadCount: f.num().nullable(), similarMomentsCount: f.num().default(0), unreadSimilarMomentsCount: f.num().default(0), impressionScore: f.num().nullable(), impressionUuid: f.str().nullable(), sequenceNumber: f.num().nullable(), vibeId: f.id().from((input: any) => input.vibeId).nullable(), widgets: f.raw<any[]>().from((input: any) => input.widgets ?? undefined).default(() => []), metrics: f.object(metricsSchema).from((input: any) => input.metrics ?? null).nullable(), createdAt: f.str(), updatedAt: f.str()
    },
    scopes: { byUser: ({ by: { userId: 'userId' }, sort: { field: 'createdAt', dir: 'desc' } }), byUuid: ({ by: { uuid: 'uuid' } }), feed: ({ sort: 'server-order' }), myMoments: ({ sort: { comparator: compareCompassMoments, orderFields: ['unreadSimilarMomentsCount', 'createdAt'] } }), compassRelations: ({ sort: 'server-order' }) },
    relations: () => ({ user: belongsTo<any, any>(users, { foreignKey: 'userId' }) }),
    write: { groups: [{ fields: ['media'] as const, policy: { monotonic: { all: [{ ladder: { path: 'media.transcodeStatus', tiers: [['processing'], ['ready', 'failed', 'completed']] } }, { tuple: ['media.transcodeProgress'] }] } } }] }
  });

  return { users, chats, messages, moments, currentUser, counters, vibes, walletTransactions };
};

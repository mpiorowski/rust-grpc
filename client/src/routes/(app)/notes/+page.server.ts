import { error, fail } from "@sveltejs/kit";
import type { PageServerLoad, Actions } from "./$types";
import {
    URI_NOTES_GO,
    URI_NOTES_RUST,
    URI_USERS_GO,
    URI_USERS_RUST,
} from "$env/static/private";
import type { UserId } from "$lib/proto/proto/UserId";
import type { Note__Output } from "$lib/proto/proto/Note";
import type { User__Output } from "$lib/proto/proto/User";
import type { NoteId } from "$lib/proto/proto/NoteId";
import { createMetadata } from "$lib/server/metadata";
import {
    notesGoClient,
    notesRustClient,
    usersGoClient,
    usersRustClient,
} from "$lib/server/grpc";
import { z } from "zod";
import type { Empty__Output } from "$lib/proto/proto/Empty";
import { logger } from "$lib/logging";

export const load = (async ({ locals, url }) => {
    try {
        const start = performance.now();

        const isGo = url.searchParams.get("lang") === "go";
        const uriNotes = isGo ? URI_NOTES_GO : URI_NOTES_RUST;
        const clientNotes = isGo ? notesGoClient : notesRustClient;
        const uriUsers = isGo ? URI_USERS_GO : URI_USERS_RUST;
        const clientUsers = isGo ? usersGoClient : usersRustClient;

        const userId = locals.userId;
        const request: UserId = { userId: userId };
        const userIds = new Set<string>();

        /**
         * Get notes
         */
        let metadata = await createMetadata(uriNotes);
        const stream = clientNotes.GetNotes(request, metadata);
        const notes: (Omit<Note__Output, "id" | "userId"> & {
            id: string;
            userId: string;
        })[] = [];

        await new Promise<void>((resolve, reject) => {
            stream.on("data", (note: Note__Output) => {
                userIds.add(note.userId);
                notes.push({
                    ...note,
                    id: note.id,
                    userId: note.userId,
                });
            });
            stream.on("end", () => resolve());
            stream.on("error", (err: unknown) => reject(err));
        });

        /**
         * Get users from Rust server
         */
        metadata = await createMetadata(uriUsers);
        const usersStream = clientUsers.getUsers(
            { userIds: Array.from(userIds) },
            metadata,
        );
        type User = Omit<User__Output, "id"> & { id: string };
        const users: User[] = [];
        const usersPromise = new Promise<User[]>((resolve, reject) => {
            usersStream.on("data", (user: User__Output) =>
                users.push({ ...user, id: user.id.toString() }),
            );
            usersStream.on("end", () => resolve(users));
            usersStream.on("error", (err: unknown) => reject(err));
        });

        return {
            notes: notes,
            time: performance.now() - start,
            length: notes.length,
            stream: {
                users: usersPromise,
            },
        };
    } catch (err) {
        logger.error(err);
        throw error(500, "Could not load notes");
    }
}) satisfies PageServerLoad;

export const actions = {
    createNote: async ({ locals, request }) => {
        try {
            const start = performance.now();

            const form = await request.formData();
            const id = form.get("id");
            const title = form.get("title");
            const content = form.get("content");
            const type = form.get("type");

            const data = {
                id: id,
                title: title,
                content: content,
                userId: locals.userId,
            };

            const schema = z
                .object({
                    id: z.string().uuid().or(z.literal("")),
                    userId: z.string().uuid(),
                    title: z.string().min(1).max(100),
                    content: z.string().min(1).max(1000),
                })
                .safeParse(data);

            if (!schema.success) {
                return fail(409, { error: schema.error.flatten() });
            }

            const isGo = type === "go";
            const uriNotes = isGo ? URI_NOTES_GO : URI_NOTES_RUST;
            const clientNotes = isGo ? notesGoClient : notesRustClient;

            const metadata = await createMetadata(uriNotes);
            await new Promise<Empty__Output>((resolve, reject) => {
                clientNotes.CreateNote(schema.data, metadata, (err, response) =>
                    err || !response ? reject(err) : resolve(response),
                );
            });
            const end = performance.now();
            return {
                duration: end - start,
            };
        } catch (err) {
            logger.error(err);
            throw error(500, "Could not create note");
        }
    },
    deleteNote: async ({ locals, request }) => {
        try {
            const start = performance.now();

            const form = await request.formData();
            const id = form.get("id");
            const type = form.get("type");

            const schema = z
                .object({
                    id: z.string().uuid(),
                    type: z.union([z.literal("go"), z.literal("rust")]),
                })
                .safeParse({ id: id, type: type });
            if (!schema.success) {
                throw error(400, "Missing id");
            }
            const data: NoteId = {
                noteId: schema.data.id,
                userId: locals.userId,
            };

            const isGo = schema.data.type === "go";
            const uriNotes = isGo ? URI_NOTES_GO : URI_NOTES_RUST;
            const clientNotes = isGo ? notesGoClient : notesRustClient;

            const metadata = await createMetadata(uriNotes);
            await new Promise<void>((resolve, reject) => {
                clientNotes.deleteNote(data, metadata, (err) =>
                    err ? reject(err) : resolve(),
                );
            });

            const end = performance.now();
            return {
                duration: end - start,
            };
        } catch (err) {
            logger.error(err);
            throw error(500, "Failed to delete note");
        }
    },
} satisfies Actions;

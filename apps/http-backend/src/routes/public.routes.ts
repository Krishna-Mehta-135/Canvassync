import { Router } from "express";
import { getPublicBoard } from "../controllers/public.controller";

const publicRouter: Router = Router();

// Unauthenticated: the unguessable token in the URL is the credential.
publicRouter.get("/board/:token", getPublicBoard);

export { publicRouter };

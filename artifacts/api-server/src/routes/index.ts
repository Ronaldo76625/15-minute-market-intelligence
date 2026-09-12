import { Router, type IRouter } from "express";
import healthRouter from "./health";
import kalshiRouter from "./kalshi";

const router: IRouter = Router();

router.use(healthRouter);
router.use(kalshiRouter);

export default router;

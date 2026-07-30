import { Workbench } from '@/components/live/Workbench';

/**
 * The workbench.
 *
 * This page previously rendered a hand-written fixture — four Pittsburgh
 * candidates, invented evidence, an invented cascade trace — and an operator
 * quite reasonably read it as real output. There is now no fixture anywhere in
 * this route: `Workbench` starts empty and every value it displays afterwards
 * arrives from `POST /api/upload` and `POST /api/analyze`, or is absent.
 *
 * Nothing is fetched here. The run happens in an event handler inside the client
 * component, so opening the app makes no claim and issues no request.
 */
export default function Page() {
  return <Workbench />;
}

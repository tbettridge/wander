import { prepareInteriorRoom } from './interiorgeometry.mjs';
self.onmessage = ({ data }) => {
  try {
    const result = prepareInteriorRoom(data.building, data.roomId);
    const transfers = [result.major, result.decoration].flatMap(tier => Object.values(tier).map(a => a.buffer));
    self.postMessage({ id: data.id, result }, transfers);
  } catch (error) { self.postMessage({ id: data.id, error: String(error.message || error) }); }
};

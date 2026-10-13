/**
 * Who may edit or delete a cluster. Every member may use clusters (create,
 * clone, start, terminate, attach notebooks, run jobs); only the cluster's
 * owner or a team admin may change or delete it. A cluster without an owner
 * (made before owners were recorded) is for admins only.
 */

export function canManageCluster(user: { email: string; admin: boolean }, owner: string | undefined): boolean {
  if (user.admin) return true;
  return !!owner && !!user.email && owner.toLowerCase() === user.email.toLowerCase();
}

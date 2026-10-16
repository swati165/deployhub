import { useNavigate } from 'react-router-dom'
import { GitBranch, Rocket, ChevronRight } from 'lucide-react'
import Card from './Card'
import Badge from './Badge'
import {
  deploymentStatusLabel,
  deploymentStatusTone,
  isActiveDeploymentStatus,
} from '../utils/deploymentStates'

/**
 * ProjectCard
 * Displays a single project summary in the Projects grid.
 * Clicking navigates to that project's detail page.
 *
 * Props:
 * - project: object from mockData.projects
 */
function ProjectCard({ project }) {
  const navigate = useNavigate()

  const badgeStatus = deploymentStatusTone(project.status)
  const stack = project.techStack || (project.stack ? [project.stack] : [])

  return (
    <Card hover onClick={() => navigate(`/projects/${project.id}`)}>
      {/* Header: name + status */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold text-base">{project.name}</h3>
          <p className="text-text-secondary text-xs mt-1 line-clamp-2">
            {project.description}
          </p>
        </div>
        <Badge status={badgeStatus} pulse={isActiveDeploymentStatus(project.status)}>
          {deploymentStatusLabel(project.status)}
        </Badge>
      </div>

      {/* Tech stack tags */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {stack.map((tech) => (
          <span
            key={tech}
            className="text-xs px-2 py-1 rounded-md bg-bg-hover text-text-secondary border border-border-subtle"
          >
            {tech}
          </span>
        ))}
      </div>

      {/* Footer: branch, deployments count, last deployed */}
      <div className="flex items-center justify-between text-xs text-text-tertiary pt-3 border-t border-border-subtle">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <GitBranch size={12} /> {project.branch}
          </span>
          <span className="flex items-center gap-1">
            <Rocket size={12} /> {project.deploymentsCount}
          </span>
        </div>
        <span className="flex items-center gap-1">
          {project.lastDeployed ? new Date(project.lastDeployed).toLocaleDateString() : 'No deployments'}
          <ChevronRight size={14} />
        </span>
      </div>
    </Card>
  )
}

export default ProjectCard